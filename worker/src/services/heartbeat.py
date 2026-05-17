"""Cron-heartbeat building blocks (VPS-6).

Two thin helpers over the existing ``sync_log`` table
(``db/migrations/0001_initial_schema.sql``):

* :func:`log_success` writes a finished/ok row for a named job.
* :func:`last_success_age_seconds` reports how long ago that job last
  succeeded, in seconds, or ``None`` if it has never succeeded.

These are intentionally **not** wired into the actual cron jobs in this PR
— that lives under #59 (systemd timers on the VPS). They exist here so the
monitoring runbook (``infra/monitoring/README.md``) has a concrete answer
to "how does Healthchecks.io decide a job is late?" once we want to push
heartbeats from inside the worker rather than from a wrapper script.

The ``sync_log`` schema is:

    id            uuid pk
    source        text not null       -- job name, e.g. "meta_ads_pull"
    started_at    timestamptz default now()
    finished_at   timestamptz
    rows_upserted int
    status        sync_status         -- 'running' | 'ok' | 'error'
    error_text    text
    payload       jsonb

We always insert a row that is "already finished" (``status='ok'``,
``finished_at=now()``) — the existing audit-pull code uses the start/finish
pattern for long-running runs, but the heartbeat use case is a synchronous
"this job completed successfully" event.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ..supabase_client import get_supabase_admin


_TABLE = "sync_log"


def log_success(job_name: str, *, rows_upserted: int | None = None) -> None:
    """Insert a single ``status='ok'`` row for ``job_name``.

    ``started_at`` defaults via the DB; we set ``finished_at`` to "now" so
    queries can rely on it being non-null for any successful run. The
    optional ``rows_upserted`` is passed through for jobs that want to
    record throughput alongside the heartbeat.

    Raises:
        RuntimeError: if Supabase is not configured (see
            :func:`src.supabase_client.get_supabase_admin`).
    """
    sb = get_supabase_admin()
    now_iso = datetime.now(tz=timezone.utc).isoformat()
    row: dict[str, object] = {
        "source": job_name,
        "finished_at": now_iso,
        "status": "ok",
    }
    if rows_upserted is not None:
        row["rows_upserted"] = rows_upserted
    sb.table(_TABLE).insert(row).execute()


def last_success_age_seconds(job_name: str) -> int | None:
    """Seconds since the most recent ``status='ok'`` row for ``job_name``.

    Returns ``None`` if the job has never logged a success. Callers can use
    that to distinguish "stale" (large int) from "never ran" (None).

    Implementation note: we read ``finished_at`` rather than ``started_at``
    because a job that started and crashed mid-run shouldn't count as a
    successful heartbeat — :func:`log_success` only writes rows that have
    both ``finished_at`` set and ``status='ok'``.
    """
    sb = get_supabase_admin()
    result = (
        sb.table(_TABLE)
        .select("finished_at")
        .eq("source", job_name)
        .eq("status", "ok")
        .order("finished_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        return None
    finished_at_raw = rows[0].get("finished_at")
    if not finished_at_raw:
        return None

    # Supabase returns ISO-8601 with a trailing 'Z' or '+00:00'. Python's
    # fromisoformat handles +00:00 natively; normalize Z to be safe.
    if isinstance(finished_at_raw, str) and finished_at_raw.endswith("Z"):
        finished_at_raw = finished_at_raw[:-1] + "+00:00"
    finished_at = datetime.fromisoformat(finished_at_raw)
    if finished_at.tzinfo is None:
        finished_at = finished_at.replace(tzinfo=timezone.utc)

    delta = datetime.now(tz=timezone.utc) - finished_at
    return max(0, int(delta.total_seconds()))
