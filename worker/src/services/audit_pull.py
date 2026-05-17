"""Audit pull orchestrator — Meta + GHL → join → verdict → persist.

End-to-end pipeline kicked off by ``/work/audit/run`` (image, M4-1) and
``/work/audit/video`` (video, M4-13):

1. Resolve the set of clients to audit. Either a single explicit
   ``client_id`` or all active clients with both Meta + GHL configured.
2. For each client, in parallel:

   * Pull Meta campaign insights for the window (image or video field set).
   * Pull GHL contacts for the same window so we can attribute leads.

3. Join Meta and GHL rows by ``campaign_id``. The Meta-side ``leads`` count
   stays as ``leads_meta``; the GHL-side count rolls up into ``leads_ghl``.
4. Compute the verdict via the existing :mod:`.verdict` / :mod:`.verdict_video`
   modules and persist the row through :mod:`.audit_persist`.
5. Emit notification events for any verdict that crossed to ``"kill"`` so the
   web-push + email delivery channels (M4-10 / M4-11) can fan them out.

The orchestrator deliberately keeps verdict computation centralized inside
``audit_persist`` so the rules cannot diverge between the persist path and
the notification path.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import structlog

from ..supabase_client import get_supabase_admin
from .audit_persist import (
    ImagePerfRow,
    VideoPerfRow,
    upsert_image_perf,
    upsert_video_perf,
)
from .ghl import GHLClient, GHLContact
from .meta import CampaignInsight, MetaAdsClient
from .notifications import NotificationEvent, emit
from .verdict import ImagePerfInput, compute_verdict as compute_image_verdict
from .verdict_video import VideoPerfInput, compute_verdict as compute_video_verdict


log = structlog.get_logger(__name__)


AuditFormat = Literal["image", "video"]


# ---------------------------------------------------------------------------
# Client resolution
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ClientRow:
    """Subset of the ``clients`` row needed for the audit pull."""

    id: str
    name: str
    slug: str
    meta_account_id: str
    ghl_location_id: str
    cpl_target: float | None


def _row_to_client(row: dict[str, Any]) -> ClientRow | None:
    """Return a :class:`ClientRow` from a clients table row, or None if unusable."""
    meta_account_id = (row.get("meta_account_id") or "").strip()
    ghl_location_id = (row.get("ghl_location_id") or "").strip()
    # We need at least Meta to do anything useful — GHL is optional but
    # without Meta the row has no leads/spend.
    if not meta_account_id:
        return None
    return ClientRow(
        id=str(row.get("id")),
        name=str(row.get("name") or ""),
        slug=str(row.get("slug") or ""),
        meta_account_id=meta_account_id,
        ghl_location_id=ghl_location_id,
        cpl_target=_safe_float(row.get("cpl_target")),
    )


def _safe_float(value: object) -> float | None:
    """Cast a Supabase numeric to float, tolerating None and strings."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


async def fetch_clients(client_id: str | None) -> list[ClientRow]:
    """Resolve the set of clients to audit.

    Args:
        client_id: When set, return just that one client (still gated on
            having a Meta account ID configured). When None, return every
            ``status = 'active'`` client.
    """
    sb = get_supabase_admin()
    query = sb.table("clients").select(
        "id, name, slug, meta_account_id, ghl_location_id, cpl_target, status"
    )
    if client_id:
        query = query.eq("id", client_id)
    else:
        query = query.eq("status", "active")
    result = query.execute()
    rows: list[dict[str, Any]] = getattr(result, "data", None) or []
    out: list[ClientRow] = []
    for row in rows:
        c = _row_to_client(row)
        if c is None:
            log.warning("audit_skip_client_missing_meta", client_id=row.get("id"), name=row.get("name"))
            continue
        out.append(c)
    return out


# ---------------------------------------------------------------------------
# Per-client pull + join
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class JoinedRow:
    """One joined Meta + GHL row, ready to feed into ``audit_persist``.

    ``leads_meta`` and ``leads_ghl`` are kept separate so we preserve both
    counts in the persisted row — the persisted view can pick which to
    surface in the UI.
    """

    client_id: str
    campaign_id: str
    campaign_name: str
    spend: float
    impressions: int
    clicks: int
    ctr: float
    freq: float
    leads_meta: int
    leads_ghl: int
    cpl_real: float | None
    cpl_target: float | None
    days_since_launch: int
    # Video-only — None for image runs.
    hook_rate: float | None = None
    drop_off_3s: float | None = None
    view_rate_avg: float | None = None
    watch_time_p50: float | None = None


def join_by_campaign(
    insights: list[CampaignInsight],
    contacts: list[GHLContact],
    *,
    client: ClientRow,
    window_days: int,
    format: AuditFormat,
) -> list[JoinedRow]:
    """Join Meta insights with GHL contact counts keyed by campaign_id.

    Meta is the spine — every Meta campaign in the window emits one
    :class:`JoinedRow`, even if zero GHL contacts attributed back to it. GHL
    contacts that don't carry a campaign_id are aggregated under the empty
    string and ignored by the join (they're still counted in the per-client
    junk-leads metrics elsewhere).
    """
    ghl_by_campaign: dict[str, int] = {}
    for c in contacts:
        if not c.campaign_id:
            continue
        ghl_by_campaign[c.campaign_id] = ghl_by_campaign.get(c.campaign_id, 0) + 1

    rows: list[JoinedRow] = []
    for ins in insights:
        leads_ghl = ghl_by_campaign.get(ins.campaign_id, 0)
        total_leads = ins.leads + leads_ghl
        cpl_real = (ins.spend / total_leads) if total_leads > 0 else None

        rows.append(
            JoinedRow(
                client_id=client.id,
                campaign_id=ins.campaign_id,
                campaign_name=ins.campaign_name,
                spend=ins.spend,
                impressions=ins.impressions,
                clicks=ins.clicks,
                ctr=ins.ctr,
                freq=ins.frequency,
                leads_meta=ins.leads,
                leads_ghl=leads_ghl,
                cpl_real=cpl_real,
                cpl_target=client.cpl_target,
                days_since_launch=window_days,  # best-effort proxy
                hook_rate=ins.hook_rate if format == "video" else None,
                drop_off_3s=ins.drop_off_3s if format == "video" else None,
                view_rate_avg=ins.view_rate_avg if format == "video" else None,
                watch_time_p50=ins.watch_time_p50 if format == "video" else None,
            )
        )
    return rows


# ---------------------------------------------------------------------------
# Verdict helpers (kept tiny — single source of truth lives in audit_persist)
# ---------------------------------------------------------------------------


def _verdict_for(row: JoinedRow, *, format: AuditFormat) -> tuple[str, str]:
    """Return ``(verdict, reason)`` for a joined row, by format."""
    if format == "video":
        v, r = compute_video_verdict(
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
                hook_rate=row.hook_rate or 0.0,
                drop_off_3s=row.drop_off_3s or 0.0,
                view_rate_avg=row.view_rate_avg or 0.0,
                watch_time_p50=row.watch_time_p50 or 0.0,
            )
        )
    else:
        v, r = compute_image_verdict(
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
    return v, r


def _to_image_row(row: JoinedRow, *, window_days: int) -> ImagePerfRow:
    return ImagePerfRow(
        client_id=row.client_id,
        campaign_id=row.campaign_id,
        window_days=window_days,
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


def _to_video_row(row: JoinedRow, *, window_days: int) -> VideoPerfRow:
    return VideoPerfRow(
        client_id=row.client_id,
        campaign_id=row.campaign_id,
        window_days=window_days,
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
        hook_rate=row.hook_rate or 0.0,
        drop_off_3s=row.drop_off_3s or 0.0,
        view_rate_avg=row.view_rate_avg or 0.0,
        watch_time_p50=row.watch_time_p50 or 0.0,
    )


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------


async def _emit_kill_notifications(
    rows: list[tuple[JoinedRow, str, str]],
    *,
    format: AuditFormat,
) -> int:
    """Emit one notification per ``verdict == 'kill'`` row.

    Returns the number of distinct (non-deduped) emissions. Dedupe scope is
    one notification per (campaign_id, format) per 24h to avoid spamming the
    operator when the same campaign stays in kill across daily pulls.
    """
    sent = 0
    ref_table = f"campaign_perf_{format}"
    for row, verdict, reason in rows:
        if verdict != "kill":
            continue
        # Reference ID for the event row points at the campaign — we don't
        # yet have the post-upsert row id at this point in the pipeline.
        ref_id = row.campaign_id
        ok = await emit(
            NotificationEvent(
                kind="kill_threshold",
                ref_table=ref_table,
                ref_id=ref_id,
                payload={
                    "campaign_id": row.campaign_id,
                    "campaign_name": row.campaign_name,
                    "client_id": row.client_id,
                    "spend": row.spend,
                    "leads_meta": row.leads_meta,
                    "leads_ghl": row.leads_ghl,
                    "verdict_reason": reason,
                    "format": format,
                },
                dedupe_key=f"kill:{format}:{row.campaign_id}",
                dedupe_window_minutes=60 * 24,
            )
        )
        if ok:
            sent += 1
    return sent


# ---------------------------------------------------------------------------
# Pull helpers (one client at a time, parallelized inside ``run_audit``)
# ---------------------------------------------------------------------------


async def _pull_for_client(
    client: ClientRow,
    *,
    window_days: int,
    format: AuditFormat,
    meta_client: MetaAdsClient,
    ghl_client: GHLClient | None,
) -> list[JoinedRow]:
    """Pull Meta + GHL data for one client and join the result.

    Meta is mandatory; GHL is best-effort — if the client has no
    ``ghl_location_id`` we just attribute zero GHL leads to every campaign
    so the run can still produce a verdict on the Meta-only signal.
    """
    # Meta + GHL concurrently — Meta is usually the slower hop.
    async def _meta_task() -> list[CampaignInsight]:
        return await meta_client.fetch_campaign_insights(
            client.meta_account_id,
            window_days,
            video_metrics=(format == "video"),
        )

    async def _ghl_task() -> list[GHLContact]:
        if ghl_client is None or not client.ghl_location_id:
            return []
        since = datetime.now(timezone.utc) - timedelta(days=window_days)
        return await ghl_client.fetch_contacts_for_location(
            client.ghl_location_id, since=since
        )

    insights, contacts = await asyncio.gather(_meta_task(), _ghl_task())
    return join_by_campaign(
        insights,
        contacts,
        client=client,
        window_days=window_days,
        format=format,
    )


# ---------------------------------------------------------------------------
# Result + entry point
# ---------------------------------------------------------------------------


@dataclass
class AuditReport:
    """End-of-run summary returned by ``run_audit``."""

    format: AuditFormat
    window_days: int
    clients_processed: int
    rows_processed: int
    rows_upserted: int
    kills: int
    notifications_emitted: int
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": self.format,
            "window_days": self.window_days,
            "clients_processed": self.clients_processed,
            "rows_processed": self.rows_processed,
            "rows_upserted": self.rows_upserted,
            "kills": self.kills,
            "notifications_emitted": self.notifications_emitted,
            "errors": list(self.errors),
        }


async def run_audit(
    *,
    format: AuditFormat,
    client_id: str | None = None,
    window_days: int = 30,
) -> AuditReport:
    """Run the Meta + GHL → join → verdict → persist → notify pipeline.

    Args:
        format: ``"image"`` or ``"video"`` — picks the field set and the
            target table / verdict module.
        client_id: When set, restrict the pull to that single client.
        window_days: Lookback window. Must be one of ``1``, ``7``, ``30`` to
            keep the daily-uniq index meaningful.

    Returns:
        :class:`AuditReport` summarizing the run.
    """
    if format not in ("image", "video"):
        raise ValueError(f"format must be 'image' or 'video', got {format!r}")
    if window_days not in (1, 7, 30):
        raise ValueError(f"window_days must be one of 1, 7, 30 (got {window_days})")

    clients = await fetch_clients(client_id)
    if not clients:
        log.info("audit_no_clients", client_id=client_id)
        return AuditReport(
            format=format,
            window_days=window_days,
            clients_processed=0,
            rows_processed=0,
            rows_upserted=0,
            kills=0,
            notifications_emitted=0,
        )

    # Build clients once for the whole run; reuse the HTTP connection pools.
    all_joined: list[JoinedRow] = []
    errors: list[str] = []

    async with MetaAdsClient() as meta_client:
        # GHL is optional — if the env var isn't set, every contact pull
        # returns []; we still produce a Meta-only audit.
        ghl_client: GHLClient | None
        try:
            ghl_client = GHLClient()
            await ghl_client.__aenter__()
        except RuntimeError as e:
            log.warning("audit_ghl_unavailable", error=str(e))
            ghl_client = None

        try:
            for client in clients:
                try:
                    joined = await _pull_for_client(
                        client,
                        window_days=window_days,
                        format=format,
                        meta_client=meta_client,
                        ghl_client=ghl_client,
                    )
                    all_joined.extend(joined)
                except Exception as e:  # noqa: BLE001 — operator wants to see the rest of the run
                    log.exception(
                        "audit_client_failed",
                        client_id=client.id,
                        client_name=client.name,
                    )
                    errors.append(f"{client.name or client.id}: {e}")
        finally:
            if ghl_client is not None:
                await ghl_client.aclose()

    # Compute verdicts (twice — once for the row payload, once for the
    # notification scan). audit_persist computes its own verdict to keep
    # the schema-write path the single source of truth; we recompute here
    # to know which rows crossed to kill *without* depending on what
    # Supabase returned.
    enriched: list[tuple[JoinedRow, str, str]] = []
    for row in all_joined:
        v, r = _verdict_for(row, format=format)
        enriched.append((row, v, r))

    kill_count = sum(1 for _row, v, _r in enriched if v == "kill")

    # Upsert through the existing audit_persist surface.
    if format == "video":
        upserted = await upsert_video_perf(
            [_to_video_row(row, window_days=window_days) for row, _v, _r in enriched]
        )
    else:
        upserted = await upsert_image_perf(
            [_to_image_row(row, window_days=window_days) for row, _v, _r in enriched]
        )

    # Notification fan-out for kills.
    emitted = await _emit_kill_notifications(enriched, format=format)

    report = AuditReport(
        format=format,
        window_days=window_days,
        clients_processed=len(clients),
        rows_processed=len(all_joined),
        rows_upserted=upserted,
        kills=kill_count,
        notifications_emitted=emitted,
        errors=errors,
    )
    log.info("audit_done", **report.to_dict())
    return report


__all__ = [
    "AuditFormat",
    "AuditReport",
    "ClientRow",
    "JoinedRow",
    "fetch_clients",
    "join_by_campaign",
    "run_audit",
]
