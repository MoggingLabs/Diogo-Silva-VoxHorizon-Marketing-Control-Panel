"""Outbox consumer: drains work_item rows of the outbox-* kinds (PR-4).

Silent-failure foundational redesign, PR-4: with the legacy
``integration_outbox`` table renamed ``_legacy_*`` and the per-domain
``outbox_relay`` deleted, the durable external-write follow-throughs ride the
``work_item`` queue. The producers (``routes.integrations``) enqueue rows of
kind ``outbox_meta_record_launch`` / ``outbox_drive_finalize_verified`` /
``outbox_ghl_send`` IN THE SAME HANDLER as the state change they record (so the
side effect cannot be lost across a crash); this module is the missing drain
half. The unified ``run_work_item_watchdog_once`` handles stuck-row rotation +
dead-lettering -- this module owns only the dispatch (claim -> perform handler
-> close).

One pass (:func:`run_outbox_drain_once`):

  1. For each registered kind, atomically claim ONE due row via
     ``claim_work_item(kind, consumer)`` (the FOR UPDATE SKIP LOCKED RPC from
     migration 0050) so N drain consumers never collide.
  2. Dispatch to the kind's handler in :data:`_HANDLERS`. A handler returns
     a result dict on success and raises on a retryable failure.
  3. On success: token-scoped UPDATE to ``status='completed'`` (clears the
     claim). On failure: the row is left ``running`` -- the watchdog observes
     the stale heartbeat and either requeues (attempt < max) or dead-letters
     (attempt >= max) with exponential backoff. Keeping requeue in ONE place
     (the watchdog) is how the redesign guarantees retries can never go
     untracked.
  4. The handlers are NO-OP shells today (mirrors the deleted ``outbox_relay``
     handlers which were also acknowledged-only): Meta + Drive are
     operator-held MCP, so the worker is the recorder. The contract (enqueue
     -> drain -> close) is intact + tested, so the real side effect drops in
     here as a one-function change when those connectors land.

Bounded per pass implicitly: one claim per kind per pass mirrors the rotation
budget on the watchdog so a backlog can't fan out an unbounded burst of
external calls. A per-row failure is logged and skipped so one bad row never
aborts the sweep.
"""

from __future__ import annotations

import socket
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

import structlog

from ..config import Settings
from . import work_queue


log = structlog.get_logger(__name__)


# Side-effect handler: given the work_item row's payload, perform the external
# write and return a JSON-serialisable result dict (stored in ``result``).
# Raising signals a retryable failure -- the row is left held; the watchdog
# rotates it after the heartbeat goes stale, applying exponential backoff +
# dead-letter at max attempts.
OutboxHandler = Callable[[Any, Mapping[str, Any]], Awaitable[Mapping[str, Any]]]


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


async def _handle_meta_record_launch(
    sb: Any, payload: Mapping[str, Any]
) -> Mapping[str, Any]:
    """Side effect for a recorded Meta launch (idempotent follow-through).

    The launch entities are already recorded transactionally by the producer
    (``routes.integrations.record_launch``); this handler performs the durable
    follow-through (the part that must survive a crash + retry). It is
    intentionally a no-op shell today -- the operator's MCP owns the live Meta
    activation behind the approval gate, so there is no worker-side Meta call
    to make yet. It exists so the enqueue -> drain contract is complete +
    tested and the real follow-through is a one-function change with no
    consumer/route churn.
    """
    log.info(
        "outbox_meta_record_launch_handled",
        pipeline_id=payload.get("pipeline_id"),
        entity_count=len(payload.get("entities") or []),
    )
    return {"acknowledged": True, "pipeline_id": payload.get("pipeline_id")}


async def _handle_drive_finalize_verified(
    sb: Any, payload: Mapping[str, Any]
) -> Mapping[str, Any]:
    """Side effect for a finalized Drive asset (idempotent follow-through).

    The creatives are already stamped ``finalize_verified`` transactionally by
    the producer (``routes.integrations.finalize_drive``); this handler
    performs the durable follow-through. Like the Meta handler it is a no-op
    shell today (Drive is operator-held MCP -- the worker is the recorder),
    present so the durable enqueue -> drain path is complete and the real
    effect drops in without touching the consumer or the route.
    """
    log.info(
        "outbox_drive_finalize_verified_handled",
        pipeline_id=payload.get("pipeline_id"),
        asset_count=len(payload.get("assets") or []),
    )
    return {"acknowledged": True, "pipeline_id": payload.get("pipeline_id")}


async def _handle_ghl_send(
    sb: Any, payload: Mapping[str, Any]
) -> Mapping[str, Any]:
    """Side effect for an outbound GHL action (idempotent follow-through).

    Reserved for future GHL outbound writes (the inbound webhook ingest in
    ``routes.integrations.ghl_webhook`` is the only GHL path live today).
    No-op shell so the kind is wired -- producers can enqueue it the day a
    real GHL outbound write is needed.
    """
    log.info(
        "outbox_ghl_send_handled",
        pipeline_id=payload.get("pipeline_id"),
    )
    return {"acknowledged": True, "pipeline_id": payload.get("pipeline_id")}


# Per-kind dispatch table. New outbox-style kinds wire here.
_HANDLERS: dict[str, OutboxHandler] = {
    "outbox_meta_record_launch": _handle_meta_record_launch,
    "outbox_drive_finalize_verified": _handle_drive_finalize_verified,
    "outbox_ghl_send": _handle_ghl_send,
}


# ---------------------------------------------------------------------------
# Drain pass
# ---------------------------------------------------------------------------


def _consumer_id() -> str:
    """Stable consumer identifier (one per worker host).

    The work_item ``claimed_by`` column records who holds a row; using the
    hostname (with a stable prefix) lets the dashboard surface the draining
    worker and keeps two worker replicas from accidentally appearing as the
    same consumer to the watchdog.
    """
    host = socket.gethostname() or "unknown"
    return f"outbox-worker-{host}"


async def run_outbox_drain_once(
    settings: Settings,
    *,
    kinds: list[str],
    sb: Any | None = None,
) -> dict[str, int]:
    """One bounded pass of the outbox drainer. Returns a per-kind tally.

    For each kind in ``kinds``: atomically claim one due row, dispatch to the
    registered handler, and close the row (complete on success; leave held on
    failure so the watchdog rotates it). Returns ``{kind: rows_completed}``
    for observability -- a kind that had nothing due reports 0. A per-row
    failure is logged + the row is left held; the watchdog owns retry / dead-
    letter (single source of truth for the retry chain).

    The token-scoped UPDATE returns 0 rows when the watchdog rotated the token
    mid-handler; that's logged + skipped (the watchdog owns it now, the
    drainer must not double-close).
    """
    if sb is None:
        from ..supabase_client import get_supabase_admin  # lazy: mirror peers

        sb = get_supabase_admin()

    consumer = _consumer_id()
    tally: dict[str, int] = {kind: 0 for kind in kinds}

    for kind in kinds:
        handler = _HANDLERS.get(kind)
        if handler is None:
            log.warning("outbox_drain_no_handler", kind=kind)
            continue

        try:
            row = work_queue.claim_work_item(sb, kind=kind, consumer=consumer)
        except Exception as exc:  # noqa: BLE001 -- one bad claim never sinks the pass
            log.warning("outbox_drain_claim_failed", kind=kind, error=str(exc))
            continue
        if row is None:
            continue

        work_item_id = str(row.get("id") or "")
        claim_token = row.get("claim_token")
        if not work_item_id or not claim_token:
            # The claim RPC should never return a row without an id + token;
            # defensive skip so a defective row never sinks the loop.
            log.warning(
                "outbox_drain_claim_malformed",
                kind=kind,
                row_id=work_item_id,
                has_token=bool(claim_token),
            )
            continue
        claim_token = str(claim_token)
        payload = row.get("payload")
        payload = payload if isinstance(payload, dict) else {}

        try:
            result = await handler(sb, payload)
        except Exception as exc:  # noqa: BLE001 -- watchdog owns retry
            # Leave the row HELD (status='claimed'/'running' with the token).
            # The watchdog observes the stale heartbeat past
            # ``work_item_heartbeat_threshold_s`` and rotates -- either
            # requeueing (attempt < max) or dead-lettering. Keeping retry in
            # one place is the redesign's invariant.
            log.warning(
                "outbox_drain_handler_failed",
                kind=kind,
                work_item_id=work_item_id,
                pipeline_id=row.get("pipeline_id"),
                error=str(exc),
            )
            continue

        # Close the row -- token-scoped so a watchdog rotation mid-handler
        # leaves us a no-op (the watchdog owns the row now).
        closed = work_queue.complete_work_item(
            sb,
            work_item_id=work_item_id,
            claim_token=claim_token,
            result=dict(result) if isinstance(result, Mapping) else None,
        )
        if not closed:
            log.warning(
                "outbox_drain_complete_token_rotated",
                kind=kind,
                work_item_id=work_item_id,
            )
            continue

        tally[kind] += 1
        log.info(
            "outbox_drain_completed",
            kind=kind,
            work_item_id=work_item_id,
            pipeline_id=row.get("pipeline_id"),
        )

    log.info("outbox_drain_pass_done", tally=tally)
    return tally


__all__ = [
    "OutboxHandler",
    "run_outbox_drain_once",
]
