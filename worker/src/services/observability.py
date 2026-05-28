"""Observability primitives for the pipeline rebuild (P5.6 / #369).

Two small, dependency-light surfaces the integrations layer wires together:

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

Both read off the unified ``work_item`` queue (silent-failure redesign); the
former per-row "stuck" classifiers (``stuck_dispatches`` / ``stuck_outbox``)
were removed once the unified work_item watchdog took over stale-claim rotation
for every kind. Slack alert delivery reuses the existing Slack helper at wire
time (see :mod:`services.scheduler`); not imported here so this module stays
I/O-free and trivially testable.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator, Mapping
from datetime import datetime, timezone
from typing import Any

import structlog


log = structlog.get_logger(__name__)


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
