"""Main daemon orchestrator.

Owns the drain loop, the per-claim heartbeat task, the consumer heartbeat
task, and the SIGTERM clean-shutdown path. Each piece is small enough that
the load-bearing test (``test_daemon_run.py``) can substitute fakes for the
queue client and the hermes_exec wrapper and drive the loop directly.

The single load-bearing invariant: every claimed work_item has either
``complete`` or ``fail`` called on it before the daemon stops responding
to that claim. SIGTERM marks the in-flight row failed with
``error_kind='consumer_shutdown'`` so the watchdog requeues it; a 409
from the heartbeat (token rotated) flips ``cancel_current_work`` so the
chat task is torn down without us racing the worker.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

import structlog

from .hermes_exec import HermesExec
from .queue_client import (
    QueueAuthError,
    QueueClient,
    QueueClientError,
    QueueServerError,
)
from .settings import Settings
from .startup import run_startup_check
from .types import ChatResult, DaemonErrorKind, StartupCheck, WorkItem


log = structlog.get_logger(__name__)


@dataclass
class DaemonState:
    """Shared mutable state for the healthz endpoint + the loops.

    Defined as a plain dataclass so tests can introspect it directly. All
    mutation happens on the event loop thread, so there is no lock.
    """

    startup_check: StartupCheck | None = None
    consumer_status: str = "starting"
    last_consumer_heartbeat: float = 0.0
    last_drain_iteration: float = 0.0
    in_flight: dict[str, Any] = field(default_factory=dict)


class Daemon:
    """The drain loop + heartbeat tasks + SIGTERM handler."""

    def __init__(
        self,
        *,
        settings: Settings,
        queue_client: QueueClient,
        hermes_exec: HermesExec,
        # Test hook: a callable that yields control on every loop iteration.
        # Production passes ``asyncio.sleep`` directly.
        sleep: Any = asyncio.sleep,
        # Test hook: an explicit stop event the test can set to end the run.
        stop_event: asyncio.Event | None = None,
    ) -> None:
        self.settings = settings
        self.queue_client = queue_client
        self.hermes_exec = hermes_exec
        self._sleep = sleep
        self._stop_event = stop_event or asyncio.Event()
        # Set when the per-work-item heartbeat detects a token rotation. The
        # drain loop awaits the chat task with this flag in-mind so we can
        # tear the chat call down cleanly instead of completing into the void.
        self._cancel_current_work = asyncio.Event()
        self.state = DaemonState()

    # ------------------------------------------------------------------
    # public lifecycle
    # ------------------------------------------------------------------

    def request_stop(self) -> None:
        """Trigger clean shutdown (called by the SIGTERM signal handler)."""
        self._stop_event.set()

    async def run(self) -> int:
        """Top-level lifecycle. Returns the process exit code.

        Order: startup self-test -> upsert consumer -> launch consumer
        heartbeat task -> drain loop until stop. On startup failure: upsert
        consumer 'down' with the failing check and exit 1 so the container
        restart-loop becomes the LOUD signal.
        """
        check = await run_startup_check(
            queue_client=self.queue_client,
            hermes_exec=self.hermes_exec,
            auth_probe_enabled=self.settings.startup_auth_probe,
        )
        self.state.startup_check = check
        startup_payload = check.model_dump()

        if not check.all_ok:
            failure = check.first_failure()
            log.error(
                "operator_daemon_startup_failed",
                failing_check=failure,
                startup_check=startup_payload,
            )
            self.state.consumer_status = "down"
            await self._safe_upsert_consumer(
                status="down", startup_check=startup_payload
            )
            return 1

        log.info("operator_daemon_startup_ok", startup_check=startup_payload)
        await self._safe_upsert_consumer(
            status="live", startup_check=startup_payload
        )
        self.state.consumer_status = "live"

        consumer_hb_task = asyncio.create_task(
            self._consumer_heartbeat_loop(), name="consumer-heartbeat"
        )
        try:
            await self._drain_loop()
        finally:
            consumer_hb_task.cancel()
            try:
                await consumer_hb_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            await self._mark_consumer_stopped()
        return 0

    # ------------------------------------------------------------------
    # consumer heartbeat
    # ------------------------------------------------------------------

    async def _consumer_heartbeat_loop(self) -> None:
        """Bump ``work_item_consumers.last_seen_at`` every heartbeat_s.

        The dashboard derives staleness as ``last_seen_at < now - 2*N``, so
        a single missed beat shows "stale" yellow, two misses red.
        """
        while not self._stop_event.is_set():
            try:
                await self.queue_client.heartbeat_consumer(
                    self.settings.consumer_id
                )
                self.state.last_consumer_heartbeat = time.monotonic()
            except QueueAuthError:
                # Bad bearer mid-run. Refusing to retry is correct: a rotated
                # secret is an operator-side problem and the daemon stopping
                # is the loud signal.
                log.error("operator_daemon_consumer_heartbeat_auth_failed")
                self.request_stop()
                return
            except QueueServerError as exc:
                log.warning(
                    "operator_daemon_consumer_heartbeat_server_error",
                    error=str(exc),
                )
            except QueueClientError as exc:
                log.warning(
                    "operator_daemon_consumer_heartbeat_failed",
                    error=str(exc),
                )

            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=self.settings.consumer_heartbeat_s,
                )
            except asyncio.TimeoutError:
                continue

    # ------------------------------------------------------------------
    # drain loop
    # ------------------------------------------------------------------

    async def _drain_loop(self) -> None:
        """Claim -> run -> close. One row at a time. Exits on stop."""
        while not self._stop_event.is_set():
            self.state.last_drain_iteration = time.monotonic()

            try:
                work_item = await self.queue_client.claim("operator_dispatch")
            except QueueAuthError:
                log.error("operator_daemon_drain_claim_auth_failed")
                self.request_stop()
                return
            except QueueServerError as exc:
                log.warning(
                    "operator_daemon_drain_claim_server_error", error=str(exc)
                )
                await self._sleep(self.settings.claim_poll_interval_s)
                continue
            except QueueClientError as exc:
                log.warning(
                    "operator_daemon_drain_claim_failed", error=str(exc)
                )
                await self._sleep(self.settings.claim_poll_interval_s)
                continue

            if work_item is None:
                await self._sleep(self.settings.claim_poll_interval_s)
                continue

            await self._handle_work_item(work_item)

    async def _handle_work_item(self, work_item: WorkItem) -> None:
        """Drive one work_item from claim to terminal.

        Spawns the per-claim heartbeat task; runs hermes chat; closes the
        row. The whole block is wrapped in try/finally so a crash in the
        chat path always lands on either ``complete`` or ``fail``.
        """
        self._cancel_current_work.clear()
        self.state.in_flight = {
            "work_item_id": work_item.id,
            "claim_token": work_item.claim_token,
            "started_at": time.monotonic(),
        }
        log.info(
            "operator_daemon_work_item_claimed",
            work_item_id=work_item.id,
            pipeline_id=work_item.pipeline_id,
            attempt=work_item.attempt,
        )

        hb_task = asyncio.create_task(
            self._heartbeat_task(work_item.id, work_item.claim_token),
            name=f"work-item-heartbeat-{work_item.id}",
        )

        try:
            chat_result = await self._run_chat_with_rotation_check(work_item)
        finally:
            hb_task.cancel()
            try:
                await hb_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

        # If the heartbeat task observed a token rotation, the worker has
        # already requeued this row under a new token; we MUST NOT attempt to
        # close it (the watchdog owns it now). Just clear in-flight state.
        if self._cancel_current_work.is_set():
            log.warning(
                "operator_daemon_work_item_claim_rotated",
                work_item_id=work_item.id,
            )
            self.state.in_flight = {}
            return

        if chat_result is None:
            # The chat path was cancelled (stop event) but the row is still
            # ours. The outer cleanup path in run() will mark it failed.
            return

        await self._close_work_item(work_item, chat_result)
        self.state.in_flight = {}

    async def _run_chat_with_rotation_check(
        self, work_item: WorkItem
    ) -> ChatResult | None:
        """Race the chat call against the rotation event + stop event."""
        instruction = self._instruction_from_payload(work_item)
        session_id = self._session_id(work_item)

        chat_task = asyncio.create_task(
            self.hermes_exec.chat(
                instruction,
                session_id,
                max_turns=self.settings.chat_max_turns,
                timeout_s=self.settings.chat_timeout_s,
            ),
            name=f"hermes-chat-{work_item.id}",
        )

        cancel_waiter = asyncio.create_task(
            self._cancel_current_work.wait(), name="cancel-current"
        )
        stop_waiter = asyncio.create_task(
            self._stop_event.wait(), name="daemon-stop"
        )

        try:
            done, _pending = await asyncio.wait(
                {chat_task, cancel_waiter, stop_waiter},
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            for t in (cancel_waiter, stop_waiter):
                if not t.done():
                    t.cancel()

        if chat_task in done:
            return chat_task.result()

        # Either the heartbeat saw a rotation or SIGTERM fired. Cancel the
        # chat task; the docker exec inside the container will keep running
        # but the next claim() will skip past this row.
        chat_task.cancel()
        try:
            await chat_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        return None

    async def _close_work_item(
        self, work_item: WorkItem, chat_result: ChatResult
    ) -> None:
        """PATCH /complete or /fail based on the chat result."""
        if chat_result.error_kind is None:
            ok = await self._safe_complete(work_item, chat_result)
            if not ok:
                # Complete races a watchdog rotation; nothing else to do.
                log.warning(
                    "operator_daemon_complete_token_rotated",
                    work_item_id=work_item.id,
                )
            else:
                log.info(
                    "operator_daemon_work_item_completed",
                    work_item_id=work_item.id,
                )
            return

        # A classified failure. Auth + skill failures additionally stop the
        # daemon so the container restart-loop becomes the loud signal.
        await self._safe_fail(work_item, chat_result)
        log.warning(
            "operator_daemon_work_item_failed",
            work_item_id=work_item.id,
            error_kind=chat_result.error_kind,
            exit_code=chat_result.exit_code,
        )
        if chat_result.error_kind in ("auth_expired", "skill_missing"):
            log.error(
                "operator_daemon_stopping_due_to_fatal_kind",
                error_kind=chat_result.error_kind,
            )
            self.state.consumer_status = "down"
            await self._safe_update_consumer_status(
                "down",
                startup_check={"reason": chat_result.error_kind},
            )
            self.request_stop()

    # ------------------------------------------------------------------
    # heartbeat per claim
    # ------------------------------------------------------------------

    async def _heartbeat_task(self, work_item_id: str, claim_token: str) -> None:
        """Bump heartbeat every N seconds; set cancel_current on token rotation."""
        while not self._stop_event.is_set():
            try:
                ok = await self.queue_client.heartbeat_work_item(
                    work_item_id, claim_token
                )
            except QueueAuthError:
                log.error(
                    "operator_daemon_work_heartbeat_auth_failed",
                    work_item_id=work_item_id,
                )
                self._cancel_current_work.set()
                self.request_stop()
                return
            except QueueServerError as exc:
                log.warning(
                    "operator_daemon_work_heartbeat_server_error",
                    work_item_id=work_item_id,
                    error=str(exc),
                )
                # transient — try again next tick
            except QueueClientError as exc:
                log.warning(
                    "operator_daemon_work_heartbeat_failed",
                    work_item_id=work_item_id,
                    error=str(exc),
                )
            else:
                if not ok:
                    log.warning(
                        "operator_daemon_work_heartbeat_token_rotated",
                        work_item_id=work_item_id,
                    )
                    self._cancel_current_work.set()
                    return

            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=self.settings.work_item_heartbeat_s,
                )
                # stop set; exit
                return
            except asyncio.TimeoutError:
                continue

    # ------------------------------------------------------------------
    # write helpers (all swallow exceptions so the loop never dies on
    # bookkeeping; the watchdog requeues anything we leave half-closed)
    # ------------------------------------------------------------------

    async def _safe_upsert_consumer(
        self, *, status: str, startup_check: dict[str, Any]
    ) -> None:
        try:
            await self.queue_client.upsert_consumer(
                consumer_id=self.settings.consumer_id,
                kind="operator_dispatch",
                status=status,  # type: ignore[arg-type]
                startup_check=startup_check,
                image_tag=self.settings.image_tag,
                hostname=self.settings.hostname,
            )
        except QueueClientError as exc:
            log.warning(
                "operator_daemon_upsert_consumer_failed", error=str(exc)
            )

    async def _safe_update_consumer_status(
        self,
        status: str,
        *,
        startup_check: dict[str, Any] | None = None,
    ) -> None:
        try:
            await self.queue_client.update_consumer(
                consumer_id=self.settings.consumer_id,
                status=status,  # type: ignore[arg-type]
                startup_check=startup_check,
            )
        except QueueClientError as exc:
            log.warning(
                "operator_daemon_update_consumer_failed", error=str(exc)
            )

    async def _safe_complete(
        self, work_item: WorkItem, chat_result: ChatResult
    ) -> bool:
        try:
            return await self.queue_client.complete(
                work_item.id,
                work_item.claim_token,
                result={
                    "stdout_tail": chat_result.stdout_tail,
                    "exit_code": chat_result.exit_code,
                },
            )
        except QueueClientError as exc:
            log.warning(
                "operator_daemon_complete_failed",
                work_item_id=work_item.id,
                error=str(exc),
            )
            return False

    async def _safe_fail(
        self,
        work_item: WorkItem,
        chat_result: ChatResult,
        *,
        override_error_kind: DaemonErrorKind | None = None,
    ) -> None:
        kind = override_error_kind or (chat_result.error_kind or "unknown")
        try:
            await self.queue_client.fail(
                work_item.id,
                work_item.claim_token,
                error_kind=str(kind),
                error_detail={
                    "stdout_tail": chat_result.stdout_tail,
                    "exit_code": chat_result.exit_code,
                },
                retryable=kind in ("llm_5xx", "docker_exec_failed", "unknown"),
                backoff_seconds=60,
            )
        except QueueClientError as exc:
            log.warning(
                "operator_daemon_fail_failed",
                work_item_id=work_item.id,
                error_kind=kind,
                error=str(exc),
            )

    async def _mark_consumer_stopped(self) -> None:
        """On clean shutdown: fail any in-flight row + mark consumer stopped."""
        in_flight = self.state.in_flight
        if in_flight:
            try:
                await self.queue_client.fail(
                    in_flight["work_item_id"],
                    in_flight["claim_token"],
                    error_kind="consumer_shutdown",
                    error_detail={"reason": "sigterm"},
                    retryable=True,
                )
            except QueueClientError as exc:
                log.warning(
                    "operator_daemon_shutdown_fail_failed",
                    error=str(exc),
                )
            self.state.in_flight = {}

        try:
            await self.queue_client.update_consumer(
                consumer_id=self.settings.consumer_id,
                status="stopped",
            )
        except QueueClientError as exc:
            log.warning(
                "operator_daemon_shutdown_update_consumer_failed",
                error=str(exc),
            )

    # ------------------------------------------------------------------
    # payload helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _instruction_from_payload(work_item: WorkItem) -> str:
        """Pull the operator instruction from the payload.

        The dashboard enqueues operator_dispatch with the instruction under
        ``payload.instruction`` (see plan-of-record). A missing instruction
        is a producer-side bug; the daemon surfaces it as a non-empty string
        so hermes does not get an empty -q argument.
        """
        instruction = work_item.payload.get("instruction") if isinstance(
            work_item.payload, dict
        ) else None
        if not isinstance(instruction, str) or not instruction.strip():
            return f"work_item:{work_item.id}: empty payload.instruction"
        return instruction

    @staticmethod
    def _session_id(work_item: WorkItem) -> str:
        """The session id passed to ``--pass-session-id``.

        Falls back to the work_item id when no pipeline_id is set so
        ad-hoc kinds (with ``pipeline_id=None``) still get a stable session.
        """
        return work_item.pipeline_id or work_item.id


__all__ = ["Daemon", "DaemonState"]
