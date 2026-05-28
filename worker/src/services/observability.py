"""Observability primitives for the pipeline rebuild (P5.6 / #369).

Three small, dependency-light surfaces the integrations layer wires together:

  1. **Correlation-id binding.** :func:`bind_pipeline` /
     :func:`bound_pipeline` bind ``pipeline_id`` (the architecture's per-call
     trace id, Layer 6) into structlog's contextvars so every log line emitted
     for the duration of a request/job carries it — a retried call or a
     fan-out across services is one greppable thread by ``pipeline_id``.

  2. **Metrics snapshot.** :func:`metrics_snapshot` rolls the four numbers the
     ``/work/metrics`` endpoint exposes (outbox depth, breaker state, in-flight
     operator dispatches, cost-vs-cap) into a plain dict from cheap reads — the
     route in :mod:`routes.integrations` is a thin shell over it. Kept pure
     against an injected supabase handle + breaker map so it unit-tests with the
     in-memory double and no live HTTP.

  3. **Watchdogs.** :func:`stuck_dispatches` + :func:`stuck_outbox` are pure
     functions over already-fetched rows + a ``now`` clock: they classify which
     operator dispatches and outbox entries have been stuck past their timeout
     so a caller (a cron-driven re-dispatch / alert) can act. No I/O, no
     hidden clock — fully deterministic in tests.

The cron wiring (a periodic task that calls the watchdogs and fans alerts to
Slack, distinct from the approval long-poll) is deferred — these are the pure
cores it will call. Slack alert delivery reuses the existing
:mod:`services.notifications` Slack helper at wire time; not imported here so
this module stays I/O-free and trivially testable.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog


log = structlog.get_logger(__name__)


# Default "stuck" thresholds. An operator dispatch with no terminal status (and
# no heartbeat) past this is presumed wedged; an outbox row still pending past
# this many seconds is presumed stalled. Both are conservative — far longer than
# a healthy stage dispatch / outbox drain — so a slow-but-alive job is never
# flagged.
DEFAULT_DISPATCH_TIMEOUT_S = 900.0  # 15 min
DEFAULT_OUTBOX_TIMEOUT_S = 300.0  # 5 min

# Open-dispatch statuses (mirrors the operator_dispatches partial index in 0023:
# rows in these states have no terminal outcome yet).
_OPEN_DISPATCH_STATUSES: frozenset[str] = frozenset({"dispatched", "running"})
# Outbox statuses that represent undelivered work (mirrors the 0023 due index).
_OPEN_OUTBOX_STATUSES: frozenset[str] = frozenset({"pending", "inflight"})


# ---------------------------------------------------------------------------
# Correlation-id binding
# ---------------------------------------------------------------------------


def bind_pipeline(pipeline_id: str | None, **extra: Any) -> None:
    """Bind ``pipeline_id`` (+ any extra fields) into the structlog context.

    Every log line emitted after this call — across services, for the life of
    the current request/task — carries ``pipeline_id`` so a multi-stage run is
    one greppable thread. Binding ``None`` is a no-op (an unscoped call).
    """
    fields: dict[str, Any] = dict(extra)
    if pipeline_id is not None:
        fields["pipeline_id"] = pipeline_id
    if fields:
        structlog.contextvars.bind_contextvars(**fields)


def clear_pipeline() -> None:
    """Clear the bound correlation context (end of a request/task)."""
    structlog.contextvars.clear_contextvars()


@contextlib.contextmanager
def bound_pipeline(pipeline_id: str | None, **extra: Any) -> Iterator[None]:
    """Context manager that binds the correlation context then restores it.

    Unlike :func:`bind_pipeline` + :func:`clear_pipeline`, this nests safely:
    it snapshots the existing contextvars on entry and resets them on exit, so
    binding a ``pipeline_id`` inside an already-bound scope doesn't wipe the
    outer scope's fields.
    """
    tokens = structlog.contextvars.bind_contextvars(
        **{k: v for k, v in {"pipeline_id": pipeline_id, **extra}.items() if v is not None}
    )
    try:
        yield
    finally:
        structlog.contextvars.reset_contextvars(**tokens)


# ---------------------------------------------------------------------------
# Watchdogs (pure)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StuckItem:
    """One item a watchdog flagged as stuck past its timeout.

    ``kind`` is ``"dispatch"`` or ``"outbox"``; ``ref`` is the natural id
    (dispatch_id / idempotency_key); ``age_s`` is how long it has been wedged.
    ``row`` carries the original record for the caller's alert/re-dispatch.
    """

    kind: str
    pipeline_id: str | None
    ref: str
    age_s: float
    row: dict[str, Any]


def _parse_ts(value: Any) -> datetime | None:
    """Parse a Supabase timestamptz (ISO string / datetime) to aware UTC."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    iso = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def stuck_dispatches(
    rows: Iterable[Mapping[str, Any]],
    *,
    now: datetime,
    timeout_s: float = DEFAULT_DISPATCH_TIMEOUT_S,
) -> list[StuckItem]:
    """Flag operator dispatches wedged past ``timeout_s``.

    A dispatch is *stuck* when its status is still open
    (``dispatched``/``running``) and the most-recent activity timestamp —
    ``last_heartbeat_at`` if present, else ``dispatched_at`` — is older than
    ``timeout_s`` relative to ``now``. Terminal rows (completed/failed/
    timed_out) and rows whose timestamps don't parse are skipped (a missing
    timestamp can't be aged, so it's never falsely flagged). Sorted oldest
    (most stuck) first so a caller alerts the worst offenders first.
    """
    out: list[StuckItem] = []
    for row in rows:
        status = row.get("status")
        if status not in _OPEN_DISPATCH_STATUSES:
            continue
        last = _parse_ts(row.get("last_heartbeat_at")) or _parse_ts(
            row.get("dispatched_at")
        )
        if last is None:
            continue
        age = (now - last).total_seconds()
        if age < timeout_s:
            continue
        out.append(
            StuckItem(
                kind="dispatch",
                pipeline_id=_as_opt_str(row.get("pipeline_id")),
                ref=str(row.get("dispatch_id") or row.get("id") or ""),
                age_s=age,
                row=dict(row),
            )
        )
    out.sort(key=lambda i: i.age_s, reverse=True)
    return out


def stuck_outbox(
    rows: Iterable[Mapping[str, Any]],
    *,
    now: datetime,
    timeout_s: float = DEFAULT_OUTBOX_TIMEOUT_S,
) -> list[StuckItem]:
    """Flag transactional-outbox rows undrained past ``timeout_s``.

    An outbox row is *stuck* when its status is open (``pending``/``inflight``)
    and ``created_at`` is older than ``timeout_s`` relative to ``now``. ``done``/
    ``failed``/``dead`` rows are terminal and skipped. Sorted oldest first.
    """
    out: list[StuckItem] = []
    for row in rows:
        status = row.get("status")
        if status not in _OPEN_OUTBOX_STATUSES:
            continue
        created = _parse_ts(row.get("created_at"))
        if created is None:
            continue
        age = (now - created).total_seconds()
        if age < timeout_s:
            continue
        out.append(
            StuckItem(
                kind="outbox",
                pipeline_id=_as_opt_str(row.get("pipeline_id")),
                ref=str(row.get("idempotency_key") or row.get("id") or ""),
                age_s=age,
                row=dict(row),
            )
        )
    out.sort(key=lambda i: i.age_s, reverse=True)
    return out


def _as_opt_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


# ---------------------------------------------------------------------------
# Metrics snapshot
# ---------------------------------------------------------------------------


def metrics_snapshot(
    supabase: Any,
    *,
    breaker_states: Mapping[str, str] | None = None,
    cost_total_usd: float = 0.0,
    cost_cap_usd: float | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Roll the ``/work/metrics`` numbers into a plain dict.

    Reads the open-work counts cheaply off the injected ``supabase`` handle
    (outbox depth by status, in-flight operator dispatches) and folds in the
    caller-supplied breaker map + cost figures. Every read is wrapped so one
    flaky table never sinks the whole snapshot — a failed read degrades that
    metric to its empty value and is logged, so ``/work/metrics`` is itself
    resilient (you want it MOST when something's wrong).

    Returns::

        {
          "outbox": {"pending": N, "inflight": N, "failed": N, "dead": N,
                     "depth": pending+inflight},
          "dispatches": {"in_flight": N},
          "breakers": {host: state, ...},
          "cost": {"total_usd": X, "cap_usd": Y|None, "over_cap": bool,
                   "remaining_usd": Y-X|None},
        }
    """
    clock = now or datetime.now(timezone.utc)

    outbox = _count_outbox_by_status(supabase)
    depth = outbox.get("pending", 0) + outbox.get("inflight", 0)
    outbox["depth"] = depth

    in_flight = _count_open_dispatches(supabase)

    over_cap = cost_cap_usd is not None and cost_total_usd > cost_cap_usd
    remaining = (
        round(cost_cap_usd - cost_total_usd, 6)
        if cost_cap_usd is not None
        else None
    )

    return {
        "generated_at": clock.isoformat(),
        "outbox": outbox,
        "dispatches": {"in_flight": in_flight},
        "breakers": dict(breaker_states or {}),
        "cost": {
            "total_usd": round(cost_total_usd, 6),
            "cap_usd": cost_cap_usd,
            "over_cap": over_cap,
            "remaining_usd": remaining,
        },
    }


# The outbox statuses we surface a count for. ``depth`` (the headline gauge) is
# pending+inflight; failed/dead are exposed so a growing dead-letter pile is
# visible.
_OUTBOX_REPORT_STATUSES = ("pending", "inflight", "failed", "dead")

# The work_item kinds that ARE the outbox surface (silent-failure redesign).
# The transactional outbox is no longer its own table: the Meta-launch / Drive-
# finalize / GHL-send side effects each enqueue a work_item of one of these
# kinds, drained by the outbox consumer + swept by the unified watchdog.
_OUTBOX_WORK_ITEM_KINDS = (
    "outbox_meta_record_launch",
    "outbox_drive_finalize_verified",
    "outbox_ghl_send",
)

# Map work_item_status (0050 enum) onto the four reported outbox buckets so
# /work/metrics + the dashboard keep their existing shape after the cutover off
# the legacy table:
#   * pending  <- queued        (not yet drained)
#   * inflight <- claimed/running (a consumer holds it)
#   * failed   <- failed        (retryable failure, still on the retry chain)
#   * dead     <- timed_out     (the watchdog's dead-letter terminal)
# ``completed`` + ``cancelled`` are not reported (they are not undelivered work,
# mirroring the legacy ``done`` status the old reader dropped).
_WORK_ITEM_STATUS_TO_OUTBOX_BUCKET = {
    "queued": "pending",
    "claimed": "inflight",
    "running": "inflight",
    "failed": "failed",
    "timed_out": "dead",
}


def _count_outbox_by_status(supabase: Any) -> dict[str, int]:
    """Count the outbox ``work_item`` rows per reported status (resilient).

    Silent-failure PR-6: the outbox surface lives entirely on the ``work_item``
    queue (kinds ``outbox_meta_record_launch`` / ``outbox_drive_finalize_verified``
    / ``outbox_ghl_send``). This counts those rows and maps each
    ``work_item_status`` onto the four buckets the dashboard reads
    (``pending`` / ``inflight`` / ``failed`` / ``dead`` -- see
    ``_WORK_ITEM_STATUS_TO_OUTBOX_BUCKET``), preserving the legacy return shape.
    Fail-soft: a read error degrades to all-zero counts and is logged; this
    metric never raises (you want /work/metrics MOST when something is wrong).
    """
    counts = {s: 0 for s in _OUTBOX_REPORT_STATUSES}
    try:
        resp = (
            supabase.table("work_item")
            .select("status")
            .in_("kind", list(_OUTBOX_WORK_ITEM_KINDS))
            .execute()
        )
        rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
        for row in rows:
            status = row.get("status") if isinstance(row, dict) else None
            bucket = _WORK_ITEM_STATUS_TO_OUTBOX_BUCKET.get(status)
            if bucket is not None:
                counts[bucket] += 1
    except Exception as e:  # noqa: BLE001 -- metrics never raise
        log.warning("metrics_outbox_read_failed", error=str(e))
    return counts


def _count_open_dispatches(supabase: Any) -> int:
    """Count operator dispatches still in flight (claimed/running) (resilient).

    Silent-failure PR-6: the operator-dispatch surface lives on the ``work_item``
    queue (kind ``operator_dispatch``) and the daemon owns its lifecycle. This
    counts the rows a live consumer is actively holding -- ``claimed`` or
    ``running``. Fail-soft: a read error degrades to 0 and is logged; the metric
    never raises.
    """
    try:
        resp = (
            supabase.table("work_item")
            .select("status")
            .eq("kind", "operator_dispatch")
            .in_("status", ["claimed", "running"])
            .execute()
        )
        rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
        return sum(1 for row in rows if isinstance(row, dict))
    except Exception as e:  # noqa: BLE001 -- metrics never raise
        log.warning("metrics_dispatch_read_failed", error=str(e))
        return 0
