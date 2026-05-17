"""Meta Ads (Graph API) campaign-level insights client.

Thin async wrapper around ``GET /v21.0/act_<id>/insights`` used by the audit
pulls (M4-1, M4-13). The Next.js side never talks to Meta directly — the
worker is the only thing on the path between the operator and Meta's API.

Design:

* One :class:`MetaAdsClient` instance per pull cycle. Stateless across calls;
  the client holds the token and a single ``httpx.AsyncClient`` so the connection
  pool can be reused across paginated requests.

* Field selection differs by format. Image pulls (M4-1) only need the base
  set; video pulls (M4-13) tack on the four engagement signals the
  ``compute_verdict_video`` rules check.

* Pagination follows the "next" cursor in ``paging.next`` until exhausted. We
  cap iterations at :data:`MAX_PAGES` to defend against a runaway loop.

* Conversion / leads are read from the ``actions`` array; Meta returns them
  as a list of dicts with ``action_type`` + ``value``. We extract the lead
  count for the campaign so the orchestrator can hold it alongside the GHL
  lead count.

The token is read from the ``META_ADS_API_KEY`` environment variable. The
worker config singleton already exposes this as ``meta_ads_api_key`` — we
fall back to that when no explicit token is passed.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

import httpx
import structlog


log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Meta Graph API base. Pin a stable version so a Facebook breaking change
#: can't ship without a worker deploy.
GRAPH_BASE = "https://graph.facebook.com/v21.0"

#: Hard cap on pagination iterations. Each page is up to ``limit`` rows
#: (default 100), so this is roughly 10k rows — well above any realistic
#: single-day pull for a single client.
MAX_PAGES = 100

#: Default per-page row count. Meta's default is 25; bigger pages mean fewer
#: round-trips for the typical pull.
DEFAULT_LIMIT = 100

#: Network timeout per request. Meta is usually < 1s; 30s is the runaway floor.
DEFAULT_TIMEOUT_S = 30.0


# Base fields used for every insights pull. Anything in this list must be a
# top-level field on the Meta insights node.
BASE_FIELDS: tuple[str, ...] = (
    "campaign_id",
    "campaign_name",
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "frequency",
    "cpc",
    "cpp",
    "actions",
)

# Video-specific fields layered on top of the base set. The hook + drop-off
# signals come from "video_p25_watched_actions" / "video_3_sec_watched_actions"
# action lists — we expose them as field requests but the actual extraction
# happens in :func:`_extract_video_metrics`.
VIDEO_FIELDS: tuple[str, ...] = (
    "video_3_sec_watched_actions",
    "video_p25_watched_actions",
    "video_p50_watched_actions",
    "video_p75_watched_actions",
    "video_p100_watched_actions",
    "video_avg_time_watched_actions",
    "video_thruplay_watched_actions",
)


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CampaignInsight:
    """Normalized single-campaign insights row.

    Mirrors the columns of ``campaign_perf_image`` / ``campaign_perf_video``
    minus the verdict (which the orchestrator computes). Numeric values are
    floats / ints; missing values collapse to ``0`` for counters and ``None``
    for ratios so downstream callers can distinguish "we don't know" from "zero".
    """

    campaign_id: str
    campaign_name: str
    spend: float
    impressions: int
    clicks: int
    ctr: float
    frequency: float
    leads: int
    # Video-only signals. ``None`` for image insights.
    hook_rate: float | None = None
    drop_off_3s: float | None = None
    view_rate_avg: float | None = None
    watch_time_p50: float | None = None
    raw: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Action-array parsers
# ---------------------------------------------------------------------------


def _sum_action_value(actions: list[dict[str, Any]] | None, action_type: str) -> float:
    """Return the numeric ``value`` of the first matching action, or 0."""
    if not actions:
        return 0.0
    for entry in actions:
        if not isinstance(entry, dict):
            continue
        if entry.get("action_type") == action_type:
            try:
                return float(entry.get("value", 0) or 0)
            except (TypeError, ValueError):
                return 0.0
    return 0.0


def _extract_leads(row: dict[str, Any]) -> int:
    """Pull lead count from Meta's actions array.

    Meta surfaces leads under several keys depending on optimization goal:
    ``lead``, ``onsite_conversion.lead_grouped``, ``offsite_conversion.fb_pixel_lead``.
    We sum them all so the operator's lead count matches what Ads Manager shows.
    """
    actions = row.get("actions")
    keys = (
        "lead",
        "onsite_conversion.lead_grouped",
        "offsite_conversion.fb_pixel_lead",
    )
    total = 0.0
    for k in keys:
        total += _sum_action_value(actions, k)
    return int(total)


def _extract_video_metrics(row: dict[str, Any]) -> tuple[float | None, float | None, float | None, float | None]:
    """Return ``(hook_rate, drop_off_3s, view_rate_avg, watch_time_p50)``.

    ``hook_rate`` = ``video_3_sec_watched / impressions``.
    ``drop_off_3s`` = ``1 - (video_p25_watched / video_3_sec_watched)`` (best
    available proxy — Meta doesn't expose the drop-off rate directly).
    ``view_rate_avg`` = ``video_p50_watched / impressions``.
    ``watch_time_p50`` = median seconds via ``video_avg_time_watched_actions``
    when present (Meta's closest exposed metric to a true p50).

    All four return ``None`` for impression-less rows.
    """
    impressions = float(row.get("impressions") or 0)
    if impressions <= 0:
        return None, None, None, None

    v3s = _sum_action_value(row.get("video_3_sec_watched_actions"), "video_view")
    vp25 = _sum_action_value(row.get("video_p25_watched_actions"), "video_view")
    vp50 = _sum_action_value(row.get("video_p50_watched_actions"), "video_view")
    avg_time = _sum_action_value(row.get("video_avg_time_watched_actions"), "video_view")

    hook_rate = v3s / impressions if impressions > 0 else None
    drop_off_3s = 1.0 - (vp25 / v3s) if v3s > 0 else None
    view_rate_avg = vp50 / impressions if impressions > 0 else None
    watch_time_p50 = avg_time or None

    return hook_rate, drop_off_3s, view_rate_avg, watch_time_p50


def _row_to_insight(row: dict[str, Any], *, video_metrics: bool) -> CampaignInsight:
    """Translate one Meta insights row into a :class:`CampaignInsight`."""
    impressions = int(float(row.get("impressions") or 0))
    clicks = int(float(row.get("clicks") or 0))
    spend = float(row.get("spend") or 0)
    ctr = float(row.get("ctr") or 0) / 100.0 if row.get("ctr") is not None else 0.0
    frequency = float(row.get("frequency") or 0)
    leads = _extract_leads(row)

    hook_rate = drop_off_3s = view_rate_avg = watch_time_p50 = None
    if video_metrics:
        hook_rate, drop_off_3s, view_rate_avg, watch_time_p50 = _extract_video_metrics(row)

    return CampaignInsight(
        campaign_id=str(row.get("campaign_id") or ""),
        campaign_name=str(row.get("campaign_name") or ""),
        spend=spend,
        impressions=impressions,
        clicks=clicks,
        ctr=ctr,
        frequency=frequency,
        leads=leads,
        hook_rate=hook_rate,
        drop_off_3s=drop_off_3s,
        view_rate_avg=view_rate_avg,
        watch_time_p50=watch_time_p50,
        raw=row,
    )


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class MetaAdsClient:
    """Async client for Meta Graph API campaign insights.

    Usage::

        async with MetaAdsClient() as meta:
            insights = await meta.fetch_campaign_insights("act_123", 7)
    """

    def __init__(
        self,
        access_token: str | None = None,
        *,
        base_url: str = GRAPH_BASE,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        token = access_token or os.environ.get("META_ADS_API_KEY")
        if not token:
            raise RuntimeError(
                "META_ADS_API_KEY must be set to use the Meta Ads client."
            )
        self._token = token.strip()
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_s
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "MetaAdsClient":
        self._client = httpx.AsyncClient(timeout=self._timeout)
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _client_or_default(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
        return self._client

    @staticmethod
    def _normalize_account_id(ad_account_id: str) -> str:
        """Accept either ``"123"`` or ``"act_123"`` and return the canonical form."""
        s = ad_account_id.strip()
        if not s:
            raise ValueError("ad_account_id is required")
        return s if s.startswith("act_") else f"act_{s}"

    async def fetch_campaign_insights(
        self,
        ad_account_id: str,
        window_days: int,
        *,
        video_metrics: bool = False,
        level: str = "campaign",
        limit: int = DEFAULT_LIMIT,
    ) -> list[CampaignInsight]:
        """Pull campaign-level insights for the window.

        Args:
            ad_account_id: Meta ad account ID, with or without the ``act_`` prefix.
            window_days: Lookback window in days. Translates to
                ``date_preset=last_<n>d`` (Meta only supports 1, 3, 7, 14, 28, 30 ...).
                We map 1 → ``yesterday``, 7 → ``last_7d``, 30 → ``last_30d`` and
                fall back to ``last_30d`` for unsupported windows.
            video_metrics: When True, request the video-specific field set
                and populate hook_rate / drop_off_3s / view_rate_avg / watch_time_p50.
            level: ``campaign`` (default) — could be lifted to ``ad`` later.
            limit: Per-page row count. Defaults to 100.

        Returns:
            A list of normalized :class:`CampaignInsight` rows. Pagination is
            handled transparently. Returns an empty list if the account has
            no campaigns active in the window.
        """
        normalized = self._normalize_account_id(ad_account_id)
        fields = list(BASE_FIELDS)
        if video_metrics:
            fields.extend(VIDEO_FIELDS)

        url = f"{self._base_url}/{normalized}/insights"
        params: dict[str, Any] = {
            "access_token": self._token,
            "fields": ",".join(fields),
            "level": level,
            "date_preset": _date_preset_for_window(window_days),
            "limit": limit,
        }

        client = self._client_or_default()
        rows: list[CampaignInsight] = []
        pages = 0
        next_url: str | None = url
        next_params: dict[str, Any] | None = params

        while next_url and pages < MAX_PAGES:
            log.debug(
                "meta_insights_page",
                page=pages,
                account=normalized,
                window_days=window_days,
                video_metrics=video_metrics,
            )
            resp = await client.get(next_url, params=next_params)
            if resp.status_code >= 400:
                # Surface a structured error — the orchestrator should not
                # silently swallow a 4xx (bad token, missing permission).
                raise MetaApiError(
                    f"Meta API {resp.status_code} for {normalized}: {resp.text[:300]}",
                    status=resp.status_code,
                )
            payload = resp.json()
            data = payload.get("data") or []
            for row in data:
                rows.append(_row_to_insight(row, video_metrics=video_metrics))

            # Follow the cursor. Meta returns absolute URLs in ``paging.next``
            # with the token already embedded, so we drop the manual params.
            paging = payload.get("paging") or {}
            next_url = paging.get("next")
            next_params = None
            pages += 1

        log.info(
            "meta_insights_done",
            account=normalized,
            window_days=window_days,
            rows=len(rows),
            pages=pages,
            video_metrics=video_metrics,
        )
        return rows


# ---------------------------------------------------------------------------
# Errors + helpers
# ---------------------------------------------------------------------------


class MetaApiError(RuntimeError):
    """Raised when Meta returns a non-2xx response."""

    def __init__(self, message: str, *, status: int) -> None:
        super().__init__(message)
        self.status = status


def _date_preset_for_window(window_days: int) -> str:
    """Map a window-day value to Meta's date_preset string."""
    if window_days <= 1:
        return "yesterday"
    if window_days <= 7:
        return "last_7d"
    if window_days <= 14:
        return "last_14d"
    if window_days <= 30:
        return "last_30d"
    return "last_30d"


__all__ = [
    "BASE_FIELDS",
    "VIDEO_FIELDS",
    "CampaignInsight",
    "MetaAdsClient",
    "MetaApiError",
    "GRAPH_BASE",
]
