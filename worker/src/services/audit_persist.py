"""Persist computed audit verdicts to Supabase.

Sits between the Meta/GHL pull worker (M4-1/M4-13, future) and the database.
For each fetched performance row we:

1. Compute the verdict via :mod:`.verdict` or :mod:`.verdict_video`.
2. Build the full Supabase row payload (raw metrics + verdict + reason).
3. Upsert via the daily-uniq index — one row per
   ``(client_id, campaign_id, window_days, day-of-pulled_at-UTC)``.

The supabase-py client doesn't expose a single-call upsert against a partial /
expression-based unique index, so we use the table-level ``upsert`` with the
named index. If the index name ever changes, the constants here must be
updated to match the migration.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..supabase_client import get_supabase_admin
from .verdict import ImagePerfInput, compute_verdict as compute_image_verdict
from .verdict_video import VideoPerfInput, compute_verdict as compute_video_verdict


# Name of the unique index created in 0001_initial_schema.sql. Used as the
# conflict target for the upsert.
IMAGE_DAILY_INDEX = "campaign_perf_image_daily_uniq"
VIDEO_DAILY_INDEX = "campaign_perf_video_daily_uniq"


# ---------------------------------------------------------------------------
# Row payloads
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ImagePerfRow:
    """Single image-performance row to upsert.

    Mirrors the columns of ``campaign_perf_image``. ``cpl_target`` and
    ``days_since_launch`` are not stored — they're only needed to compute the
    verdict. The remaining fields are written verbatim.
    """

    client_id: str
    campaign_id: str
    window_days: int
    spend: float
    impressions: int
    clicks: int
    ctr: float
    leads_meta: int
    leads_ghl: int
    cpl_real: float | None
    freq: float
    cpl_target: float | None
    days_since_launch: int


@dataclass(frozen=True)
class VideoPerfRow:
    """Single video-performance row to upsert.

    Extends :class:`ImagePerfRow` with the four video-only engagement
    metrics.
    """

    client_id: str
    campaign_id: str
    window_days: int
    spend: float
    impressions: int
    clicks: int
    ctr: float
    leads_meta: int
    leads_ghl: int
    cpl_real: float | None
    freq: float
    cpl_target: float | None
    days_since_launch: int
    hook_rate: float
    drop_off_3s: float
    view_rate_avg: float
    watch_time_p50: float


# ---------------------------------------------------------------------------
# Upserts
# ---------------------------------------------------------------------------


def _image_payload(row: ImagePerfRow) -> dict[str, object]:
    """Build the Supabase row dict for an image performance entry."""
    verdict, reason = compute_image_verdict(
        ImagePerfInput(
            spend=row.spend,
            impressions=row.impressions,
            clicks=row.clicks,
            ctr=row.ctr,
            leads_meta=row.leads_meta,
            leads_ghl=row.leads_ghl,
            cpl_real=row.cpl_real,
            freq=row.freq,
            cpl_target=row.cpl_target,
            days_since_launch=row.days_since_launch,
        )
    )
    return {
        "client_id": row.client_id,
        "campaign_id": row.campaign_id,
        "window_days": row.window_days,
        "spend": row.spend,
        "impressions": row.impressions,
        "clicks": row.clicks,
        "ctr": row.ctr,
        "leads_meta": row.leads_meta,
        "leads_ghl": row.leads_ghl,
        "cpl_real": row.cpl_real,
        "freq": row.freq,
        "verdict": verdict,
        "verdict_reason": reason,
    }


def _video_payload(row: VideoPerfRow) -> dict[str, object]:
    """Build the Supabase row dict for a video performance entry."""
    verdict, reason = compute_video_verdict(
        VideoPerfInput(
            spend=row.spend,
            impressions=row.impressions,
            clicks=row.clicks,
            ctr=row.ctr,
            leads_meta=row.leads_meta,
            leads_ghl=row.leads_ghl,
            cpl_real=row.cpl_real,
            freq=row.freq,
            cpl_target=row.cpl_target,
            days_since_launch=row.days_since_launch,
            hook_rate=row.hook_rate,
            drop_off_3s=row.drop_off_3s,
            view_rate_avg=row.view_rate_avg,
            watch_time_p50=row.watch_time_p50,
        )
    )
    return {
        "client_id": row.client_id,
        "campaign_id": row.campaign_id,
        "window_days": row.window_days,
        "spend": row.spend,
        "impressions": row.impressions,
        "clicks": row.clicks,
        "ctr": row.ctr,
        "leads_meta": row.leads_meta,
        "leads_ghl": row.leads_ghl,
        "cpl_real": row.cpl_real,
        "freq": row.freq,
        "hook_rate": row.hook_rate,
        "drop_off_3s": row.drop_off_3s,
        "view_rate_avg": row.view_rate_avg,
        "watch_time_p50": row.watch_time_p50,
        "verdict": verdict,
        "verdict_reason": reason,
    }


async def upsert_image_perf(rows: list[ImagePerfRow]) -> int:
    """Upsert a batch of image-performance rows.

    Conflict target: the ``campaign_perf_image_daily_uniq`` unique index, which
    enforces one row per ``(client_id, campaign_id, window_days, day-UTC)``.
    Returns the number of rows that round-tripped — useful for emitter logging.
    """
    if not rows:
        return 0
    sb = get_supabase_admin()
    payloads = [_image_payload(r) for r in rows]
    result = (
        sb.table("campaign_perf_image")
        .upsert(payloads, on_conflict=IMAGE_DAILY_INDEX)
        .execute()
    )
    data = getattr(result, "data", None) or []
    return len(data)


async def upsert_video_perf(rows: list[VideoPerfRow]) -> int:
    """Upsert a batch of video-performance rows.

    Same shape as :func:`upsert_image_perf` but writes to
    ``campaign_perf_video`` and uses the video unique index.
    """
    if not rows:
        return 0
    sb = get_supabase_admin()
    payloads = [_video_payload(r) for r in rows]
    result = (
        sb.table("campaign_perf_video")
        .upsert(payloads, on_conflict=VIDEO_DAILY_INDEX)
        .execute()
    )
    data = getattr(result, "data", None) or []
    return len(data)
