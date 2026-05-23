"""GoHighLevel (GHL) connector — lead truth for the monitor stage (P5.3 / #366).

GHL is the **source of truth for leads**, never Meta. The monitor stage computes
**real CPL = Meta spend / GHL leads**, so this connector's job is to count the
leads a campaign actually produced inside a time window, and to ingest
real-time contact/opportunity webhooks.

This module is the **connector logic only** (per #366 partial scope). The route
wiring (`POST /work/ghl/webhook`), the inbox-dedupe persistence, the daily
reconciliation job, and the `client_integrations` table read are deferred to
after P1 lands the schema — but the parsing/counting/CPL surface here is built
with clean, persistence-free interfaces so that wiring is a thin shell.

Auth — Private Integration token model
--------------------------------------
GHL v2 ("LeadConnector") uses a **Private Integration token** (an agency- or
location-scoped bearer token), NOT the legacy v1 API key. Each request also
carries:

  * ``Authorization: Bearer <token>``     — from env ``GHL_API_KEY``.
  * ``Version: 2021-07-28``               — the pinned GHL v2 API version.
  * ``locationId`` (query/body param)     — the GHL sub-account ("location").

The ``location_id`` per client comes from the ``client_integrations`` map
(client → GHL location id); callers pass it in explicitly. We never read a
location from a global env — one worker serves many clients.

Env
---
  * ``GHL_API_KEY``  — the Private Integration bearer token (required for live
                       calls; absent is fine under ``FAKE_GHL`` / in tests).
                       Read directly from the process env (not threaded through
                       the shared ``Settings`` model, which is P1-owned), so
                       this connector lands without touching shared config.
  * ``FAKE_GHL``     — when set, the connector makes ZERO network calls and
                       returns deterministic fake leads (read via ``Settings``,
                       which already declares the flag).

Rate limits
-----------
GHL v2 enforces a burst limit of **100 requests / 10 seconds** per resource
(and a daily ceiling). The pagination loops here are bounded and the underlying
:class:`~src.services._http.ResilientHttpClient` honors ``Retry-After`` and
retries 429s with backoff — so a transient burst-limit hit self-heals rather
than failing the poll.

Testing
-------
No live calls in tests — every HTTP path is driven through an
``httpx.MockTransport`` injected into the resilient client. ``real_cpl`` and
``parse_webhook_event`` are pure and unit-tested directly.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx
import structlog

from ..config import get_settings
from ._http import (
    HttpClientError,
    PermanentError,
    ResilientHttpClient,
    RetryableError,
)


log = structlog.get_logger(__name__)


# GHL v2 ("LeadConnector") endpoint surface.
API_BASE = "https://services.leadconnectorhq.com"
CONTACTS_SEARCH_URL = f"{API_BASE}/contacts/"
OPPORTUNITIES_SEARCH_URL = f"{API_BASE}/opportunities/search"

# The pinned GHL v2 API version header value. GHL requires every v2 request to
# carry this; an absent/old value is rejected.
GHL_API_VERSION = "2021-07-28"

# Env var name for the GHL Private Integration bearer token.
GHL_API_KEY_ENV = "GHL_API_KEY"


def _env_api_key() -> str | None:
    """Read + clean the GHL token from the process env (empty → None).

    Read directly here rather than via the shared ``Settings`` model so this
    connector lands without editing the P1-owned ``config.py``.
    """
    raw = os.environ.get(GHL_API_KEY_ENV)
    if raw is None:
        return None
    stripped = raw.strip()
    return stripped or None

# Page size for paginated pulls. GHL caps contacts/search at 100 per page;
# we request the max to minimize round-trips against the 100-req/10s budget.
PAGE_SIZE = 100

# Hard ceiling on pagination loops, so a misbehaving upstream (a cursor that
# never terminates) can't spin forever. 200 pages * 100 = 20k leads/window —
# far beyond any real single-campaign window.
MAX_PAGES = 200

# Webhook event types we understand. GHL fires these for the contact +
# opportunity lifecycle; we treat *create* events as new-lead signals.
WEBHOOK_CONTACT_CREATE = "ContactCreate"
WEBHOOK_OPPORTUNITY_CREATE = "OpportunityCreate"
_LEAD_CREATE_EVENTS: frozenset[str] = frozenset(
    {WEBHOOK_CONTACT_CREATE, WEBHOOK_OPPORTUNITY_CREATE}
)


class GhlError(RuntimeError):
    """Raised on any failure talking to GHL.

    Wraps the underlying :class:`~src.services._http.HttpClientError` so callers
    branch on ``transient`` (retry later) vs not. ``status_code`` / ``payload``
    carry the upstream context when available.
    """

    def __init__(
        self,
        message: str,
        *,
        transient: bool = False,
        status_code: int | None = None,
        payload: Any | None = None,
    ) -> None:
        super().__init__(message)
        self.transient = transient
        self.status_code = status_code
        self.payload = payload


@dataclass(frozen=True)
class GhlLead:
    """A single normalized lead pulled from GHL.

    Only the fields the monitor stage + reconciliation need; the raw GHL
    payload is kept on ``raw`` for the audit/evidence trail.
    """

    contact_id: str
    created_at: datetime
    source: str | None
    raw: dict[str, Any]


@dataclass(frozen=True)
class WebhookEvent:
    """A parsed GHL webhook event.

    ``is_lead`` is ``True`` for contact/opportunity *create* events (the
    signals that increment a campaign's lead count). ``dedupe_key`` is the
    deterministic idempotency key the inbox uses to drop replays.
    """

    event_type: str
    contact_id: str | None
    location_id: str | None
    created_at: datetime | None
    is_lead: bool
    dedupe_key: str
    raw: dict[str, Any]


def real_cpl(meta_spend: float, ghl_leads: int) -> float | None:
    """Real cost-per-lead = Meta spend / GHL leads (GHL is lead truth).

    Returns ``None`` when there are zero leads (divide-by-zero guard) — the
    monitor stage renders that as "n/a" / "$X spend, 0 leads" rather than a
    bogus infinite CPL. Negative inputs are rejected as a programming error.
    """
    if meta_spend < 0 or ghl_leads < 0:
        raise ValueError(
            f"real_cpl requires non-negative inputs "
            f"(spend={meta_spend!r}, leads={ghl_leads!r})"
        )
    if ghl_leads == 0:
        return None
    return meta_spend / ghl_leads


def parse_webhook_event(payload: dict[str, Any]) -> WebhookEvent:
    """Parse a GHL webhook body into a typed :class:`WebhookEvent`.

    GHL webhooks carry a ``type`` discriminator (e.g. ``"ContactCreate"``,
    ``"OpportunityCreate"``) plus the resource fields. We extract the contact
    id, location id, and timestamp, flag whether this is a new-lead create
    event, and build a deterministic ``dedupe_key`` for the inbox.

    The dedupe key prefers GHL's own event id (``id``/``webhookId``) when
    present — that's stable across redelivery — and otherwise falls back to a
    composite of ``type`` + contact id + timestamp so a replayed body without an
    event id still dedupes.

    Raises :class:`GhlError` on a non-dict / type-less payload (a malformed
    webhook the route should 422 on).
    """
    if not isinstance(payload, dict):
        raise GhlError("webhook payload is not an object")

    event_type = payload.get("type")
    if not isinstance(event_type, str) or not event_type:
        raise GhlError("webhook payload missing 'type'", payload=payload)

    contact_id = _first_str(
        payload, "contactId", "contact_id", "id"
    ) or _nested_str(payload, "contact", "id")
    location_id = _first_str(payload, "locationId", "location_id")
    created_at = _parse_ghl_datetime(
        _first_str(
            payload, "dateAdded", "dateUpdated", "createdAt", "timestamp"
        )
    )
    is_lead = event_type in _LEAD_CREATE_EVENTS

    event_id = _first_str(payload, "webhookId", "eventId")
    if event_id:
        dedupe_key = f"ghl:{event_id}"
    else:
        ts = created_at.isoformat() if created_at else "no-ts"
        dedupe_key = f"ghl:{event_type}:{contact_id or 'no-contact'}:{ts}"

    return WebhookEvent(
        event_type=event_type,
        contact_id=contact_id,
        location_id=location_id,
        created_at=created_at,
        is_lead=is_lead,
        dedupe_key=dedupe_key,
        raw=payload,
    )


class GhlClient:
    """Read-only GHL v2 connector built on :class:`ResilientHttpClient`.

    Stateless beyond the resilient client it owns; one instance per worker
    process is fine (the breaker + retry envelope are shared). Pass a
    ``transport`` (``httpx.MockTransport``) in tests to drive every call with
    zero network.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        timeout_s: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
        http_client: ResilientHttpClient | None = None,
    ) -> None:
        # FAKE_GHL mode: never calls GHL, so no key is required (parity with
        # KieClient's FAKE_RENDER). The lead-pull methods short-circuit below.
        self.fake = get_settings().fake_ghl
        resolved = api_key or _env_api_key()
        if not resolved and not self.fake:
            raise RuntimeError(
                "GHL_API_KEY not configured — set the Private Integration token "
                "in the worker .env before calling the GHL connector."
            )
        self.api_key = resolved or "fake-ghl-no-key"
        self._owns_client = http_client is None
        self._http = http_client or ResilientHttpClient(
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Version": GHL_API_VERSION,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            timeout_s=timeout_s,
            transport=transport,
        )

    async def aclose(self) -> None:
        """Close the owned resilient client (no-op for an injected one)."""
        if self._owns_client:
            await self._http.aclose()

    async def __aenter__(self) -> "GhlClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    # ------------------------------------------------------------------
    # Lead pull
    # ------------------------------------------------------------------

    async def list_leads(
        self,
        location_id: str,
        since: datetime,
        until: datetime,
        *,
        source_filter: str | None = None,
        correlation_id: str | None = None,
    ) -> list[GhlLead]:
        """Pull every lead (contact) created in ``[since, until)`` for a location.

        Paginates the GHL v2 contacts/search API, normalizes each contact to a
        :class:`GhlLead`, and (when ``source_filter`` is set) keeps only leads
        whose ``source`` contains that substring (case-insensitive) — the cheap
        client-side filter for "leads attributable to this campaign/source".

        Window is half-open ``[since, until)`` on the contact's ``dateAdded``;
        GHL's search filters by date server-side but we re-check the window
        client-side so an off-by-page boundary never miscounts.
        """
        if since > until:
            raise GhlError(f"since {since!r} is after until {until!r}")

        if self.fake:
            return _fake_leads(location_id, since, until, source_filter)

        leads: list[GhlLead] = []
        page = 1
        while page <= MAX_PAGES:
            body = {
                "locationId": location_id,
                "pageLimit": PAGE_SIZE,
                "page": page,
                "filters": [
                    {
                        "field": "dateAdded",
                        "operator": "range",
                        "value": {
                            "gte": _to_ghl_datetime(since),
                            "lt": _to_ghl_datetime(until),
                        },
                    }
                ],
            }
            data = await self._post_json(
                CONTACTS_SEARCH_URL, body, correlation_id=correlation_id
            )
            contacts = _as_list(data.get("contacts"))
            for raw in contacts:
                lead = _normalize_contact(raw)
                if lead is None:
                    continue
                if not (since <= lead.created_at < until):
                    continue
                if source_filter and not _source_matches(lead.source, source_filter):
                    continue
                leads.append(lead)

            if len(contacts) < PAGE_SIZE:
                break
            page += 1

        log.info(
            "ghl_leads_listed",
            correlation_id=correlation_id,
            location_id=location_id,
            count=len(leads),
            pages=page,
            source_filter=source_filter,
        )
        return leads

    async def count_leads_for_campaign(
        self,
        location_id: str,
        campaign_ref: str,
        window: tuple[datetime, datetime],
        *,
        correlation_id: str | None = None,
    ) -> int:
        """Count leads attributable to a campaign in a time window.

        ``campaign_ref`` is matched against the lead's GHL ``source`` /
        attribution (the same substring filter as ``list_leads``'
        ``source_filter``). ``window`` is ``(since, until)``. This is the number
        the monitor stage feeds into :func:`real_cpl`.
        """
        since, until = window
        leads = await self.list_leads(
            location_id,
            since,
            until,
            source_filter=campaign_ref,
            correlation_id=correlation_id,
        )
        return len(leads)

    # ------------------------------------------------------------------
    # Internal HTTP
    # ------------------------------------------------------------------

    async def _post_json(
        self,
        url: str,
        body: dict[str, Any],
        *,
        correlation_id: str | None,
    ) -> dict[str, Any]:
        """POST ``body`` and return the parsed JSON object, mapping errors.

        The resilient client already retried transient failures; here we
        translate its typed errors into :class:`GhlError` and validate the body
        is a JSON object.
        """
        try:
            resp = await self._http.post(
                url, json=body, correlation_id=correlation_id
            )
        except RetryableError as e:
            raise GhlError(
                f"GHL request to {url} failed transiently: {e}",
                transient=True,
                status_code=e.status_code,
                payload=e.payload,
            ) from e
        except PermanentError as e:
            raise GhlError(
                f"GHL request to {url} failed: {e}",
                transient=False,
                status_code=e.status_code,
                payload=e.payload,
            ) from e
        except HttpClientError as e:  # pragma: no cover - defensive catch-all
            raise GhlError(f"GHL request to {url} failed: {e}") from e

        try:
            data = resp.json()
        except ValueError as e:
            raise GhlError(
                f"GHL response from {url} was not JSON",
                status_code=resp.status_code,
            ) from e
        if not isinstance(data, dict):
            raise GhlError(
                f"GHL response from {url} was not a JSON object",
                status_code=resp.status_code,
                payload=data,
            )
        return data


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def _normalize_contact(raw: Any) -> GhlLead | None:
    """Map a raw GHL contact dict to a :class:`GhlLead`, or ``None`` if unusable."""
    if not isinstance(raw, dict):
        return None
    contact_id = _first_str(raw, "id", "contactId")
    created_at = _parse_ghl_datetime(
        _first_str(raw, "dateAdded", "createdAt")
    )
    if contact_id is None or created_at is None:
        return None
    source = _first_str(raw, "source", "attributionSource")
    return GhlLead(
        contact_id=contact_id,
        created_at=created_at,
        source=source,
        raw=raw,
    )


def _source_matches(source: str | None, needle: str) -> bool:
    """Case-insensitive substring match of ``needle`` in a lead ``source``."""
    if source is None:
        return False
    return needle.strip().lower() in source.lower()


def _first_str(d: dict[str, Any], *keys: str) -> str | None:
    """Return the first non-empty string value among ``keys`` in ``d``."""
    for key in keys:
        val = d.get(key)
        if isinstance(val, str) and val.strip():
            return val
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            return str(val)
    return None


def _nested_str(d: dict[str, Any], parent: str, child: str) -> str | None:
    """Return ``d[parent][child]`` as a string when both exist."""
    nested = d.get(parent)
    if isinstance(nested, dict):
        return _first_str(nested, child)
    return None


def _as_list(value: Any) -> list[Any]:
    """Coerce a value to a list (``None`` / non-list → empty)."""
    return value if isinstance(value, list) else []


def _parse_ghl_datetime(value: str | None) -> datetime | None:
    """Parse a GHL ISO-8601 timestamp into an aware UTC datetime.

    GHL emits timestamps like ``2026-05-22T14:03:11.000Z`` (and sometimes a
    bare epoch-ms int rendered as a string). Returns ``None`` on anything
    unparseable so a single bad row never crashes a pull.
    """
    if value is None:
        return None
    raw = value.strip()
    if not raw:
        return None
    # Epoch-milliseconds form (GHL sometimes sends these).
    if raw.isdigit():
        try:
            return datetime.fromtimestamp(int(raw) / 1000, tz=timezone.utc)
        except (ValueError, OverflowError, OSError):
            return None
    # ISO-8601; normalize a trailing Z to +00:00 for fromisoformat.
    iso = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return None
    # Treat naive timestamps as UTC (GHL is UTC).
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _to_ghl_datetime(dt: datetime) -> str:
    """Render a datetime as a GHL-style ISO-8601 UTC string with a Z suffix."""
    aware = dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
    return aware.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _fake_leads(
    location_id: str,
    since: datetime,
    until: datetime,
    source_filter: str | None,
) -> list[GhlLead]:
    """Deterministic FAKE_GHL leads: two leads in-window, source-tagged.

    Lets the monitor pipeline run locally / in CI with zero GHL credentials and
    a stable, non-zero lead count so :func:`real_cpl` produces a real number.
    """
    mid = since + (until - since) / 2
    base = {
        "id": f"fake-{location_id}-1",
        "dateAdded": _to_ghl_datetime(mid),
        "source": source_filter or "facebook",
    }
    second = {
        "id": f"fake-{location_id}-2",
        "dateAdded": _to_ghl_datetime(mid),
        "source": source_filter or "facebook",
    }
    leads = []
    for raw in (base, second):
        lead = _normalize_contact(raw)
        if lead is not None:
            leads.append(lead)
    return leads
