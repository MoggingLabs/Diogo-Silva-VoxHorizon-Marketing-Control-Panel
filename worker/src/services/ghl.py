"""GoHighLevel (GHL) v2 API client.

Pulls contacts + opportunities scoped to a per-client ``locationId`` so the
audit pipeline can attribute leads back to a campaign / source.

**Important: User-Agent header is a literal ``OpenClaw/1.0``.** Diogo's
Cloudflare account on the GHL side has an explicit allow rule keyed on that
string. Changing it to "voxhorizon" or anything else will get the request
silently dropped by Cloudflare's bot fight mode (the symptom is a 403 with a
JS challenge HTML body — frustrating to debug). Do **not** change it.

Source-derivation heuristics (lifted from
``voxhorizon-marketing-dept/scripts/campaign-ops/ghl_pipeline.py``):

1. Explicit ``customField.source`` overrides everything.
2. Tag-based overrides (``source:youtube``, ``source:instagram``, ...).
3. Instagram bio-link short URLs.
4. YouTube channel slugs.
5. ``attributionSource`` from Meta ad-attribution (campaign name parsing).
6. Default: ``"unknown"``.

We also filter out the classic "junk" leads (form bots, test entries, etc.)
using the same heuristics the upstream script applies.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx
import structlog


log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GHL_BASE = "https://services.leadconnectorhq.com"

# The literal Cloudflare allow-listed User-Agent. Documented per upstream
# LEARNINGS.md — do not change this string.
USER_AGENT = "OpenClaw/1.0"

# Pinned API version Diogo's GHL keys are scoped to.
API_VERSION = "2021-07-28"

# Pagination + safety caps.
DEFAULT_LIMIT = 100
MAX_PAGES = 100
DEFAULT_TIMEOUT_S = 30.0


# Cleaning regexes for the source-derivation rules. Pre-compiled at import.
_INSTAGRAM_HOST_RE = re.compile(r"(?i)\b(?:linktr\.ee|beacons\.ai|stan\.store|biolink\.ai)\b")
_UTM_SOURCE_RE = re.compile(r"(?i)utm_source=([^&\s]+)")
_AD_NAME_SOURCE_RE = re.compile(r"(?i)\b(meta|facebook|fb|instagram|ig|tiktok|youtube|yt|google)\b")


# ---------------------------------------------------------------------------
# Junk-lead filter
# ---------------------------------------------------------------------------

# Names / emails that are clearly bot-generated form submissions. Conservative
# list — only the obvious offenders, mirroring the upstream script.
_JUNK_NAME_TOKENS: tuple[str, ...] = (
    "test",
    "asdf",
    "qwer",
    "xxxxxx",
)


def is_junk_lead(contact: dict[str, Any]) -> bool:
    """Return True if the contact is almost certainly a bot/test submission.

    Heuristics:
    * No email AND no phone AND no name (empty submission).
    * Name contains one of the well-known junk tokens.
    * Email is a known disposable domain.
    """
    name = (contact.get("contactName") or contact.get("name") or "").strip().lower()
    email = (contact.get("email") or "").strip().lower()
    phone = (contact.get("phone") or "").strip()

    if not (name or email or phone):
        return True

    for token in _JUNK_NAME_TOKENS:
        if token in name:
            return True

    # Cheap disposable-email check. Extend the list as patterns appear.
    if email.endswith(("@example.com", "@test.com", "@mailinator.com", "@tempmail.com")):
        return True

    return False


# ---------------------------------------------------------------------------
# Source derivation
# ---------------------------------------------------------------------------


def derive_source(contact: dict[str, Any]) -> str:
    """Return a normalized source string for a GHL contact.

    Resolution order matches the upstream Python pipeline:

    1. ``customField.source`` (operator-set override).
    2. Any ``source:<x>`` tag.
    3. Instagram bio-link short URL in ``attributionSource.url``.
    4. YouTube channel slug in ``attributionSource.url``.
    5. ``utm_source`` parsed from any attribution URL.
    6. Ad-attribution: search the campaign name for known channel tokens.
    7. Fallback: ``"unknown"``.
    """
    custom_fields = contact.get("customFields") or []
    if isinstance(custom_fields, list):
        for cf in custom_fields:
            if not isinstance(cf, dict):
                continue
            key = (cf.get("key") or cf.get("name") or "").lower()
            value = cf.get("value")
            if key == "source" and isinstance(value, str) and value.strip():
                return value.strip().lower()

    tags = contact.get("tags") or []
    if isinstance(tags, list):
        for t in tags:
            if not isinstance(t, str):
                continue
            if t.startswith("source:"):
                return t.split(":", 1)[1].strip().lower() or "unknown"

    # Look at attributionSource / lastAttribution for URL / campaign info.
    attribution = contact.get("attributionSource") or contact.get("lastAttribution") or {}
    if isinstance(attribution, dict):
        url = attribution.get("url") or ""
        if isinstance(url, str) and url:
            if _INSTAGRAM_HOST_RE.search(url):
                return "instagram"
            if "youtube.com" in url.lower() or "youtu.be" in url.lower():
                return "youtube"
            m = _UTM_SOURCE_RE.search(url)
            if m:
                return m.group(1).lower()

        campaign = attribution.get("campaign") or attribution.get("campaignName") or ""
        if isinstance(campaign, str):
            m = _AD_NAME_SOURCE_RE.search(campaign)
            if m:
                hit = m.group(1).lower()
                # Normalize aliases.
                if hit in ("fb", "facebook", "meta", "ig", "instagram"):
                    return "meta" if hit in ("fb", "facebook", "meta") else "instagram"
                if hit in ("yt", "youtube"):
                    return "youtube"
                return hit

    return "unknown"


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GHLContact:
    """Normalized GHL contact record.

    ``campaign_id`` is the Meta campaign ID we managed to attribute back to
    this contact (best-effort — empty string when no attribution was present
    in the GHL row). The audit orchestrator joins on this.
    """

    id: str
    location_id: str
    email: str
    phone: str
    name: str
    source: str
    campaign_id: str
    created_at: str
    tags: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class GHLOpportunity:
    """Normalized GHL opportunity record."""

    id: str
    location_id: str
    pipeline_id: str
    stage_id: str
    status: str
    monetary_value: float
    contact_id: str
    created_at: str
    raw: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class GHLClient:
    """Async GHL v2 API client.

    Authenticated with a Location-scoped or Agency-scoped Bearer token. The
    User-Agent is the Cloudflare-allowlisted ``OpenClaw/1.0``; see the module
    docstring before changing it.
    """

    def __init__(
        self,
        access_token: str | None = None,
        *,
        base_url: str = GHL_BASE,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        token = access_token or os.environ.get("GHL_API_KEY")
        if not token:
            raise RuntimeError(
                "GHL_API_KEY must be set to use the GoHighLevel client."
            )
        self._token = token.strip()
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_s
        self._client: httpx.AsyncClient | None = None

    def _headers(self) -> dict[str, str]:
        """Return the canonical GHL headers — User-Agent is load-bearing."""
        return {
            "Authorization": f"Bearer {self._token}",
            "Version": API_VERSION,
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }

    async def __aenter__(self) -> "GHLClient":
        self._client = httpx.AsyncClient(timeout=self._timeout, headers=self._headers())
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _client_or_default(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout, headers=self._headers())
        return self._client

    async def fetch_contacts_for_location(
        self,
        location_id: str,
        *,
        since: datetime | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> list[GHLContact]:
        """Fetch contacts created since ``since`` for the given location.

        Args:
            location_id: GHL ``locationId`` (sub-account scope).
            since: Lower-bound ``createdAt`` filter. When None, returns the
                full page-set GHL is willing to serve.
            limit: Per-page row count.

        Returns:
            A list of :class:`GHLContact`. Junk leads are filtered out.
        """
        if not location_id:
            raise ValueError("location_id is required")
        client = self._client_or_default()

        results: list[GHLContact] = []
        page = 1
        pages = 0
        while pages < MAX_PAGES:
            params: dict[str, Any] = {
                "locationId": location_id,
                "limit": limit,
                "page": page,
            }
            if since is not None:
                # GHL accepts ISO-8601 strings on the contacts endpoint.
                params["startAfter"] = _to_iso(since)

            resp = await client.get(f"{self._base_url}/contacts/", params=params)
            if resp.status_code >= 400:
                raise GHLApiError(
                    f"GHL API {resp.status_code} for contacts (loc={location_id}): "
                    f"{resp.text[:300]}",
                    status=resp.status_code,
                )
            data = resp.json() or {}
            rows = data.get("contacts") or []
            if not rows:
                break
            for row in rows:
                if not isinstance(row, dict):
                    continue
                if is_junk_lead(row):
                    continue
                results.append(_row_to_contact(row, location_id=location_id))

            # GHL pagination: server returns ``meta.total`` + we increment page.
            if len(rows) < limit:
                break
            page += 1
            pages += 1

        log.info(
            "ghl_contacts_done",
            location_id=location_id,
            since=_to_iso(since) if since else None,
            rows=len(results),
            pages=pages + 1,
        )
        return results

    async def fetch_opportunities(
        self,
        location_id: str,
        *,
        limit: int = DEFAULT_LIMIT,
    ) -> list[GHLOpportunity]:
        """Fetch opportunities for a location.

        Used by booking-stage aggregation (Wave 5+). Lightweight wrapper for
        completeness; the audit pull doesn't currently consume the output
        but the surface exists so future stages can rely on it.
        """
        if not location_id:
            raise ValueError("location_id is required")
        client = self._client_or_default()

        results: list[GHLOpportunity] = []
        page = 1
        pages = 0
        while pages < MAX_PAGES:
            params: dict[str, Any] = {
                "location_id": location_id,
                "limit": limit,
                "page": page,
            }
            resp = await client.get(f"{self._base_url}/opportunities/search", params=params)
            if resp.status_code >= 400:
                raise GHLApiError(
                    f"GHL API {resp.status_code} for opportunities (loc={location_id}): "
                    f"{resp.text[:300]}",
                    status=resp.status_code,
                )
            data = resp.json() or {}
            rows = data.get("opportunities") or []
            if not rows:
                break
            for row in rows:
                if not isinstance(row, dict):
                    continue
                results.append(_row_to_opportunity(row, location_id=location_id))

            if len(rows) < limit:
                break
            page += 1
            pages += 1

        log.info(
            "ghl_opportunities_done",
            location_id=location_id,
            rows=len(results),
            pages=pages + 1,
        )
        return results


# ---------------------------------------------------------------------------
# Row → dataclass converters
# ---------------------------------------------------------------------------


def _row_to_contact(row: dict[str, Any], *, location_id: str) -> GHLContact:
    """Translate one GHL contact row into :class:`GHLContact`."""
    attribution = row.get("attributionSource") or row.get("lastAttribution") or {}
    campaign_id = ""
    if isinstance(attribution, dict):
        campaign_id = str(attribution.get("campaign") or attribution.get("campaignId") or "").strip()

    tags_raw = row.get("tags") or []
    tags = [t for t in tags_raw if isinstance(t, str)]

    return GHLContact(
        id=str(row.get("id") or ""),
        location_id=location_id,
        email=str(row.get("email") or "").strip(),
        phone=str(row.get("phone") or "").strip(),
        name=str(row.get("contactName") or row.get("name") or "").strip(),
        source=derive_source(row),
        campaign_id=campaign_id,
        created_at=str(row.get("dateAdded") or row.get("createdAt") or ""),
        tags=tags,
        raw=row,
    )


def _row_to_opportunity(row: dict[str, Any], *, location_id: str) -> GHLOpportunity:
    """Translate one GHL opportunity row into :class:`GHLOpportunity`."""
    try:
        monetary = float(row.get("monetaryValue") or 0)
    except (TypeError, ValueError):
        monetary = 0.0
    return GHLOpportunity(
        id=str(row.get("id") or ""),
        location_id=location_id,
        pipeline_id=str(row.get("pipelineId") or ""),
        stage_id=str(row.get("pipelineStageId") or ""),
        status=str(row.get("status") or ""),
        monetary_value=monetary,
        contact_id=str(row.get("contactId") or ""),
        created_at=str(row.get("createdAt") or ""),
        raw=row,
    )


# ---------------------------------------------------------------------------
# Errors + helpers
# ---------------------------------------------------------------------------


class GHLApiError(RuntimeError):
    """Raised when GHL returns a non-2xx response."""

    def __init__(self, message: str, *, status: int) -> None:
        super().__init__(message)
        self.status = status


def _to_iso(dt: datetime | None) -> str | None:
    """Return an ISO-8601 timestamp in UTC, or None."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


__all__ = [
    "API_VERSION",
    "GHL_BASE",
    "USER_AGENT",
    "GHLApiError",
    "GHLClient",
    "GHLContact",
    "GHLOpportunity",
    "derive_source",
    "is_junk_lead",
]
