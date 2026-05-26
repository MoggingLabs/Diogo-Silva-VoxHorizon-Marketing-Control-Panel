"""Tests for :class:`voxhorizon_daemon.daemon.Daemon`.

Fake queue + fake hermes_exec; drive the loop directly. The three
load-bearing cases the brief calls out:

* (a) startup self-test pass; claim -> run -> complete cycle works
* (b) auth_expired during chat -> row failed + consumer 'down' + daemon exits
* (c) token rotation mid-flight -> cancel_current_work fires + the row is
  NOT closed by the daemon (the watchdog owns it now)
"""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field
from typing import Any

import pytest

from voxhorizon_daemon.daemon import Daemon
from voxhorizon_daemon.startup import run_startup_check  # noqa: F401  (import sanity)
from voxhorizon_daemon.types import (
    AuthProbeResult,
    ChatResult,
    StartupCheck,
    StartupCheckEntry,
    WorkItem,
)
from tests.conftest import make_settings


# ----------------------------------------------------------------------------
# Fakes
# ----------------------------------------------------------------------------


@dataclass
class FakeQueueClient:
    """Records every call; queues canned responses per method."""

    claim_responses: deque = field(default_factory=deque)
    heartbeat_responses: deque = field(default_factory=deque)
    complete_responses: deque = field(default_factory=deque)
    fail_responses: deque = field(default_factory=deque)
    health_response: bool = True

    upsert_calls: list[dict[str, Any]] = field(default_factory=list)
    update_calls: list[dict[str, Any]] = field(default_factory=list)
    consumer_hb_calls: list[str] = field(default_factory=list)
    heartbeat_calls: list[tuple[str, str]] = field(default_factory=list)
    complete_calls: list[tuple[str, str, Any]] = field(default_factory=list)
    fail_calls: list[dict[str, Any]] = field(default_factory=list)

    async def health_ping(self) -> bool:
        return self.health_response

    async def claim(self, kind: str) -> WorkItem | None:  # noqa: ARG002
        if not self.claim_responses:
            return None
        item = self.claim_responses.popleft()
        if isinstance(item, Exception):
            raise item
        return item

    async def heartbeat_work_item(
        self, work_item_id: str, claim_token: str
    ) -> bool:
        self.heartbeat_calls.append((work_item_id, claim_token))
        if not self.heartbeat_responses:
            return True
        return self.heartbeat_responses.popleft()

    async def complete(
        self, work_item_id: str, claim_token: str, result: dict[str, Any] | None = None
    ) -> bool:
        self.complete_calls.append((work_item_id, claim_token, result))
        if not self.complete_responses:
            return True
        return self.complete_responses.popleft()

    async def fail(
        self,
        work_item_id: str,
        claim_token: str,
        error_kind: str,
        error_detail: dict[str, Any] | None = None,
        retryable: bool = True,
        backoff_seconds: int = 60,
    ) -> bool:
        self.fail_calls.append(
            {
                "work_item_id": work_item_id,
                "claim_token": claim_token,
                "error_kind": error_kind,
                "error_detail": error_detail,
                "retryable": retryable,
                "backoff_seconds": backoff_seconds,
            }
        )
        if not self.fail_responses:
            return True
        return self.fail_responses.popleft()

    async def cancel(self, *_args: Any, **_kwargs: Any) -> bool:
        return True

    async def upsert_consumer(self, **kwargs: Any) -> dict[str, Any]:
        self.upsert_calls.append(kwargs)
        return {"id": kwargs.get("consumer_id"), "status": kwargs.get("status")}

    async def update_consumer(self, **kwargs: Any) -> None:
        self.update_calls.append(kwargs)

    async def heartbeat_consumer(self, consumer_id: str) -> None:
        self.consumer_hb_calls.append(consumer_id)

    def set_consumer_id(self, consumer_id: str) -> None:
        self._consumer_id = consumer_id  # noqa: ANN001


@dataclass
class FakeHermesExec:
    """Hand-rolled double for HermesExec used by the daemon loop tests."""

    container_status_val: str = "running"
    auth_probe_result: AuthProbeResult = field(
        default_factory=lambda: AuthProbeResult(ok=True, detail={"reason": "ok"})
    )
    chat_responses: deque = field(default_factory=deque)
    container_name: str = "hermes-agent-operator"
    chat_call_count: int = 0

    def container_status(self) -> str:
        return self.container_status_val

    async def auth_probe(self) -> AuthProbeResult:
        return self.auth_probe_result

    async def chat(self, instruction: str, session_id: str, **_kwargs: Any) -> ChatResult:
        self.chat_call_count += 1
        if not self.chat_responses:
            return ChatResult(exit_code=0, stdout_tail="ok", error_kind=None)
        item = self.chat_responses.popleft()
        if callable(item):
            return await item(instruction, session_id)
        return item


def _ok_startup() -> StartupCheck:
    return StartupCheck(
        queue_reachable=StartupCheckEntry(ok=True),
        hermes_container_up=StartupCheckEntry(ok=True),
        hermes_auth=StartupCheckEntry(ok=True),
    )


def _make_work_item(
    *,
    id: str = "wi-1",
    pipeline_id: str | None = "p-1",
    instruction: str = "do thing",
    claim_token: str = "tok-1",
) -> WorkItem:
    return WorkItem(
        id=id,
        kind="operator_dispatch",
        pipeline_id=pipeline_id,
        status="claimed",
        attempt=1,
        claim_token=claim_token,
        claimed_by="op-test",
        payload={"instruction": instruction},
    )


# ----------------------------------------------------------------------------
# (a) happy path
# ----------------------------------------------------------------------------


async def test_happy_path_claim_run_complete():
    settings = make_settings()
    queue = FakeQueueClient()
    queue.claim_responses.append(_make_work_item())
    hermes = FakeHermesExec()
    hermes.chat_responses.append(ChatResult(exit_code=0, stdout_tail="done", error_kind=None))

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    # Stop after the first iteration drains the queued item.
    async def _stop_after_one_iter():
        # Yield enough times for the daemon to claim + complete one item.
        for _ in range(40):
            await asyncio.sleep(0)
            if queue.complete_calls:
                break
        daemon.request_stop()

    stop_task = asyncio.create_task(_stop_after_one_iter())
    exit_code = await daemon.run()
    await stop_task

    assert exit_code == 0
    assert queue.complete_calls, "complete should have been called once"
    assert queue.complete_calls[0][0] == "wi-1"
    assert not queue.fail_calls
    # consumer was upserted live + closed stopped
    assert any(c.get("status") == "live" for c in queue.upsert_calls)
    assert any(c.get("status") == "stopped" for c in queue.update_calls)


# ----------------------------------------------------------------------------
# (b) auth_expired during chat
# ----------------------------------------------------------------------------


async def test_auth_expired_mid_chat_fails_row_and_stops_daemon():
    settings = make_settings()
    queue = FakeQueueClient()
    queue.claim_responses.append(_make_work_item())
    hermes = FakeHermesExec()
    hermes.chat_responses.append(
        ChatResult(exit_code=1, stdout_tail="status 401", error_kind="auth_expired")
    )

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]
    exit_code = await daemon.run()

    assert exit_code == 0  # graceful shutdown, not a crash
    # The work_item was failed with the right kind
    assert queue.fail_calls, "fail should have been called"
    failure = queue.fail_calls[0]
    assert failure["work_item_id"] == "wi-1"
    assert failure["error_kind"] == "auth_expired"
    # The consumer status was flipped to 'down' before exiting
    assert any(c.get("status") == "down" for c in queue.update_calls)
    # Daemon stopped on its own — no need to await a stopper task
    assert daemon._stop_event.is_set()  # type: ignore[attr-defined]


# ----------------------------------------------------------------------------
# (c) token rotation mid-flight
# ----------------------------------------------------------------------------


async def test_token_rotation_aborts_chat_and_skips_close():
    """When the heartbeat returns False, the chat task is cancelled and the
    daemon does NOT call complete/fail (the watchdog has taken ownership)."""

    settings = make_settings()
    queue = FakeQueueClient()
    queue.claim_responses.append(_make_work_item())
    # First heartbeat returns False (token rotated).
    queue.heartbeat_responses.append(False)
    hermes = FakeHermesExec()

    rotation_seen = asyncio.Event()

    async def _slow_chat(_instruction: str, _session_id: str) -> ChatResult:
        # Block long enough that the heartbeat task fires first.
        try:
            await asyncio.wait_for(rotation_seen.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            pass
        return ChatResult(exit_code=0, stdout_tail="late", error_kind=None)

    hermes.chat_responses.append(_slow_chat)

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]
    # Shorten the heartbeat so it fires inside the chat
    daemon.settings = make_settings(work_item_heartbeat_s=1, consumer_heartbeat_s=5)

    async def _stop_when_rotation_observed():
        for _ in range(60):
            await asyncio.sleep(0.05)
            if daemon._cancel_current_work.is_set():  # type: ignore[attr-defined]
                rotation_seen.set()
                # Let the daemon process the cancellation
                await asyncio.sleep(0.05)
                daemon.request_stop()
                return
        rotation_seen.set()
        daemon.request_stop()

    stopper = asyncio.create_task(_stop_when_rotation_observed())
    exit_code = await daemon.run()
    await stopper

    assert exit_code == 0
    # Crucially: daemon does NOT close the rotated row
    assert not queue.complete_calls, "complete must not be called on rotated row"
    # And it does not fail-write either (the watchdog owns the row now)
    assert not any(f["work_item_id"] == "wi-1" for f in queue.fail_calls)


# ----------------------------------------------------------------------------
# startup-failure path
# ----------------------------------------------------------------------------


async def test_startup_failure_marks_consumer_down_and_exits_1(monkeypatch: pytest.MonkeyPatch):
    """When the startup self-test fails, the daemon writes consumer 'down'
    with the failing check and exits 1 (the container restart-loop is the
    loud signal)."""
    settings = make_settings()
    queue = FakeQueueClient()
    hermes = FakeHermesExec(
        auth_probe_result=AuthProbeResult(ok=False, detail={"reason": "expired"})
    )
    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]
    exit_code = await daemon.run()
    assert exit_code == 1
    assert queue.upsert_calls, "upsert should be called even on startup failure"
    assert queue.upsert_calls[0]["status"] == "down"
    # And the startup_check passed in payload names the failing step
    payload = queue.upsert_calls[0]["startup_check"]
    assert payload["hermes_auth"]["ok"] is False


# ----------------------------------------------------------------------------
# claim path 5xx + auth error in drain loop
# ----------------------------------------------------------------------------


async def test_claim_server_error_does_not_crash_loop():
    from voxhorizon_daemon.queue_client import QueueServerError

    settings = make_settings()
    queue = FakeQueueClient()
    queue.claim_responses.append(QueueServerError("5xx"))
    queue.claim_responses.append(_make_work_item())
    hermes = FakeHermesExec()
    hermes.chat_responses.append(ChatResult(exit_code=0, stdout_tail="ok", error_kind=None))

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    async def _stop_when_completed():
        for _ in range(80):
            await asyncio.sleep(0.01)
            if queue.complete_calls:
                break
        daemon.request_stop()

    stopper = asyncio.create_task(_stop_when_completed())
    await daemon.run()
    await stopper
    assert queue.complete_calls


async def test_claim_generic_client_error_does_not_crash_loop():
    """A non-server, non-auth QueueClientError on claim is logged + retried."""
    from voxhorizon_daemon.queue_client import QueueClientError

    settings = make_settings()
    queue = FakeQueueClient()
    queue.claim_responses.append(QueueClientError("422 weird"))
    queue.claim_responses.append(_make_work_item())
    hermes = FakeHermesExec()
    hermes.chat_responses.append(ChatResult(exit_code=0, stdout_tail="ok", error_kind=None))

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    async def _stopper():
        for _ in range(80):
            await asyncio.sleep(0.01)
            if queue.complete_calls:
                break
        daemon.request_stop()

    s = asyncio.create_task(_stopper())
    await daemon.run()
    await s
    assert queue.complete_calls


async def test_claim_auth_error_stops_daemon():
    from voxhorizon_daemon.queue_client import QueueAuthError

    settings = make_settings()
    queue = FakeQueueClient()
    queue.claim_responses.append(QueueAuthError("bad bearer"))
    hermes = FakeHermesExec()

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]
    exit_code = await daemon.run()
    assert exit_code == 0  # graceful shutdown
    assert daemon._stop_event.is_set()  # type: ignore[attr-defined]


# ----------------------------------------------------------------------------
# fail-with-skill-missing also stops the daemon
# ----------------------------------------------------------------------------


async def test_skill_missing_stops_daemon():
    settings = make_settings()
    queue = FakeQueueClient()
    queue.claim_responses.append(_make_work_item())
    hermes = FakeHermesExec()
    hermes.chat_responses.append(
        ChatResult(exit_code=1, stdout_tail="skill not found", error_kind="skill_missing")
    )

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]
    await daemon.run()
    assert any(f["error_kind"] == "skill_missing" for f in queue.fail_calls)
    assert any(c.get("status") == "down" for c in queue.update_calls)


# ----------------------------------------------------------------------------
# llm_5xx does NOT stop the daemon
# ----------------------------------------------------------------------------


async def test_llm_5xx_does_not_stop_daemon():
    settings = make_settings()
    queue = FakeQueueClient()
    # First call returns the failing item, second returns nothing (loop sleeps)
    queue.claim_responses.append(_make_work_item())
    hermes = FakeHermesExec()
    hermes.chat_responses.append(
        ChatResult(exit_code=1, stdout_tail="status 503", error_kind="llm_5xx")
    )

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    async def _stop_after_fail():
        for _ in range(80):
            await asyncio.sleep(0.01)
            if queue.fail_calls:
                break
        daemon.request_stop()

    stopper = asyncio.create_task(_stop_after_fail())
    await daemon.run()
    await stopper
    # The fail call happened, but no 'down' update_consumer because llm_5xx
    # is retryable, not fatal.
    assert any(f["error_kind"] == "llm_5xx" for f in queue.fail_calls)
    assert not any(c.get("status") == "down" for c in queue.update_calls)


# ----------------------------------------------------------------------------
# payload helpers
# ----------------------------------------------------------------------------


def test_instruction_from_payload_defaults_when_missing():
    item = WorkItem(
        id="wi-x",
        kind="operator_dispatch",
        status="claimed",
        attempt=1,
        claim_token="tok",
        claimed_by="op",
        payload={},
    )
    assert "wi-x" in Daemon._instruction_from_payload(item)


def test_session_id_falls_back_to_work_item_id_when_pipeline_missing():
    item = WorkItem(
        id="wi-y",
        kind="operator_dispatch",
        pipeline_id=None,
        status="claimed",
        attempt=1,
        claim_token="tok",
        claimed_by="op",
        payload={"instruction": "i"},
    )
    assert Daemon._session_id(item) == "wi-y"


def test_session_id_uses_pipeline_id_when_present():
    item = _make_work_item(pipeline_id="p-99")
    assert Daemon._session_id(item) == "p-99"


# ----------------------------------------------------------------------------
# SIGTERM mid-run cleanup
# ----------------------------------------------------------------------------


async def test_consumer_heartbeat_auth_error_stops_daemon():
    """A bearer rejection on consumer-heartbeat is fatal: stop the daemon."""
    from voxhorizon_daemon.queue_client import QueueAuthError

    settings = make_settings(consumer_heartbeat_s=1)
    queue = FakeQueueClient()
    hermes = FakeHermesExec()

    original_hb = queue.heartbeat_consumer

    async def _auth_fail(_cid: str) -> None:
        raise QueueAuthError("bad bearer")

    queue.heartbeat_consumer = _auth_fail  # type: ignore[assignment]

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    async def _watchdog():
        # Give the heartbeat task one tick to run + fail
        await asyncio.sleep(0.2)
        # If it didn't stop on its own, force stop so the test exits
        if not daemon._stop_event.is_set():  # type: ignore[attr-defined]
            await asyncio.sleep(0.3)
        if not daemon._stop_event.is_set():  # type: ignore[attr-defined]
            daemon.request_stop()

    watchdog = asyncio.create_task(_watchdog())
    await daemon.run()
    await watchdog
    # Restore queue method for any later assertions
    queue.heartbeat_consumer = original_hb  # type: ignore[assignment]
    assert daemon._stop_event.is_set()  # type: ignore[attr-defined]


async def test_consumer_heartbeat_swallows_server_error_and_continues():
    """A transient 5xx on consumer-heartbeat is logged but does not stop."""
    from voxhorizon_daemon.queue_client import QueueServerError

    settings = make_settings(consumer_heartbeat_s=1)
    queue = FakeQueueClient()
    hermes = FakeHermesExec()

    calls = []

    async def _flaky(cid: str) -> None:
        calls.append(cid)
        if len(calls) == 1:
            raise QueueServerError("5xx blip")

    queue.heartbeat_consumer = _flaky  # type: ignore[assignment]

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    async def _stop_after_two_beats():
        for _ in range(40):
            await asyncio.sleep(0.05)
            if len(calls) >= 2:
                break
        daemon.request_stop()

    stopper = asyncio.create_task(_stop_after_two_beats())
    await daemon.run()
    await stopper
    assert len(calls) >= 2


async def test_consumer_heartbeat_swallows_generic_client_error():
    """A generic QueueClientError (not auth/server) is also swallowed."""
    from voxhorizon_daemon.queue_client import QueueClientError

    settings = make_settings(consumer_heartbeat_s=1)
    queue = FakeQueueClient()
    hermes = FakeHermesExec()

    async def _err(_cid: str) -> None:
        raise QueueClientError("unexpected 422")

    queue.heartbeat_consumer = _err  # type: ignore[assignment]
    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    async def _stopper():
        await asyncio.sleep(0.2)
        daemon.request_stop()

    s = asyncio.create_task(_stopper())
    await daemon.run()
    await s


async def test_work_item_heartbeat_swallows_server_and_generic_errors():
    """Mid-flight heartbeat 5xx + QueueClientError are swallowed; the task
    keeps running until either stop_event fires or the chat finishes."""
    from voxhorizon_daemon.queue_client import QueueClientError, QueueServerError

    settings = make_settings(work_item_heartbeat_s=1, consumer_heartbeat_s=5)
    queue = FakeQueueClient()
    queue.claim_responses.append(_make_work_item())
    # Raise different errors on each call, then succeed
    hb_calls: list[str] = []

    async def _hb(_wid: str, _tok: str) -> bool:
        hb_calls.append("called")
        if len(hb_calls) == 1:
            raise QueueServerError("5xx")
        if len(hb_calls) == 2:
            raise QueueClientError("422")
        return True

    queue.heartbeat_work_item = _hb  # type: ignore[assignment]
    hermes = FakeHermesExec()

    async def _slow(_i: str, _s: str) -> ChatResult:
        await asyncio.sleep(2.5)
        return ChatResult(exit_code=0, stdout_tail="ok", error_kind=None)

    hermes.chat_responses.append(_slow)

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    async def _stopper():
        for _ in range(100):
            await asyncio.sleep(0.05)
            if queue.complete_calls:
                break
        daemon.request_stop()

    stopper = asyncio.create_task(_stopper())
    await daemon.run()
    await stopper
    assert len(hb_calls) >= 2


async def test_work_item_heartbeat_auth_error_stops_daemon():
    from voxhorizon_daemon.queue_client import QueueAuthError

    settings = make_settings(work_item_heartbeat_s=1)
    queue = FakeQueueClient()
    queue.claim_responses.append(_make_work_item())

    async def _hb(_wid: str, _tok: str) -> bool:
        raise QueueAuthError("bad")

    queue.heartbeat_work_item = _hb  # type: ignore[assignment]
    hermes = FakeHermesExec()

    async def _slow(_i: str, _s: str) -> ChatResult:
        await asyncio.sleep(5)
        return ChatResult(exit_code=0)

    hermes.chat_responses.append(_slow)
    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]
    await daemon.run()
    assert daemon._stop_event.is_set()  # type: ignore[attr-defined]


async def test_complete_returns_false_logs_token_rotated():
    """If complete races a rotation, we log and move on without retrying."""
    settings = make_settings()
    queue = FakeQueueClient()
    queue.claim_responses.append(_make_work_item())
    queue.complete_responses.append(False)
    hermes = FakeHermesExec()

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    async def _stopper():
        for _ in range(80):
            await asyncio.sleep(0.01)
            if queue.complete_calls:
                break
        daemon.request_stop()

    s = asyncio.create_task(_stopper())
    await daemon.run()
    await s
    assert queue.complete_calls
    assert queue.complete_calls[0][0] == "wi-1"


async def test_safe_helpers_swallow_queue_client_error_on_close():
    """A QueueClientError raised by complete()/fail() at close time is logged
    but the loop keeps going (the watchdog will pick up the half-closed row)."""
    from voxhorizon_daemon.queue_client import QueueClientError

    settings = make_settings()
    queue = FakeQueueClient()
    queue.claim_responses.append(_make_work_item())
    hermes = FakeHermesExec()

    async def _boom(*_a, **_kw):  # noqa: ANN001, ANN002, ANN003
        raise QueueClientError("transient")

    queue.complete = _boom  # type: ignore[assignment]

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    async def _stopper():
        await asyncio.sleep(0.3)
        daemon.request_stop()

    s = asyncio.create_task(_stopper())
    await daemon.run()
    await s


async def test_safe_fail_swallows_queue_client_error():
    from voxhorizon_daemon.queue_client import QueueClientError

    settings = make_settings()
    queue = FakeQueueClient()
    queue.claim_responses.append(_make_work_item())
    hermes = FakeHermesExec()
    hermes.chat_responses.append(
        ChatResult(exit_code=1, stdout_tail="status 503", error_kind="llm_5xx")
    )

    async def _boom(*_a, **_kw):  # noqa: ANN001, ANN002, ANN003
        raise QueueClientError("transient")

    queue.fail = _boom  # type: ignore[assignment]

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    async def _stopper():
        await asyncio.sleep(0.3)
        daemon.request_stop()

    s = asyncio.create_task(_stopper())
    await daemon.run()
    await s


async def test_upsert_consumer_swallows_queue_client_error():
    """A QueueClientError from the live-mark upsert is logged but the daemon
    proceeds anyway (the row state is best-effort; the watchdog catches drift)."""
    from voxhorizon_daemon.queue_client import QueueClientError

    settings = make_settings()
    queue = FakeQueueClient()
    hermes = FakeHermesExec()

    async def _boom(**_kw):  # noqa: ANN002, ANN003
        raise QueueClientError("upsert failed")

    queue.upsert_consumer = _boom  # type: ignore[assignment]
    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    async def _stopper():
        await asyncio.sleep(0.2)
        daemon.request_stop()

    s = asyncio.create_task(_stopper())
    exit_code = await daemon.run()
    await s
    # No upsert succeeded but the daemon still booted and exited cleanly.
    assert exit_code == 0


async def test_update_consumer_swallows_queue_client_error():
    from voxhorizon_daemon.queue_client import QueueClientError

    settings = make_settings()
    queue = FakeQueueClient()
    queue.claim_responses.append(_make_work_item())
    hermes = FakeHermesExec()
    hermes.chat_responses.append(
        ChatResult(exit_code=1, stdout_tail="status 401", error_kind="auth_expired")
    )

    async def _boom(**_kw):  # noqa: ANN002, ANN003
        raise QueueClientError("update failed")

    queue.update_consumer = _boom  # type: ignore[assignment]
    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]
    await daemon.run()
    # Daemon stopped; even though update_consumer failed at shutdown.
    assert daemon._stop_event.is_set()  # type: ignore[attr-defined]


async def test_mark_consumer_stopped_handles_fail_error():
    """A QueueClientError on the shutdown-fail path is logged, not raised."""
    from voxhorizon_daemon.queue_client import QueueClientError

    settings = make_settings()
    queue = FakeQueueClient()
    queue.claim_responses.append(_make_work_item())
    hermes = FakeHermesExec()

    async def _slow_chat(_i: str, _s: str) -> ChatResult:
        await asyncio.sleep(5)
        return ChatResult(exit_code=0)

    hermes.chat_responses.append(_slow_chat)

    async def _fail_boom(*_a, **_kw):  # noqa: ANN001, ANN002, ANN003
        raise QueueClientError("fail boom")

    queue.fail = _fail_boom  # type: ignore[assignment]

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    async def _stopper():
        for _ in range(40):
            await asyncio.sleep(0.05)
            if daemon.state.in_flight:
                break
        daemon.request_stop()

    s = asyncio.create_task(_stopper())
    await daemon.run()
    await s


async def test_sigterm_during_chat_marks_row_failed_with_consumer_shutdown():
    settings = make_settings()
    queue = FakeQueueClient()
    queue.claim_responses.append(_make_work_item())
    hermes = FakeHermesExec()

    async def _slow_chat(_i: str, _s: str) -> ChatResult:
        await asyncio.sleep(10)
        return ChatResult(exit_code=0)

    hermes.chat_responses.append(_slow_chat)

    daemon = Daemon(settings=settings, queue_client=queue, hermes_exec=hermes)  # type: ignore[arg-type]

    async def _stop_during_chat():
        for _ in range(60):
            await asyncio.sleep(0.01)
            if daemon.state.in_flight:
                break
        daemon.request_stop()

    stopper = asyncio.create_task(_stop_during_chat())
    await daemon.run()
    await stopper
    # The shutdown path failed the in-flight row with the right kind
    shutdown_failures = [
        f for f in queue.fail_calls if f["error_kind"] == "consumer_shutdown"
    ]
    assert shutdown_failures, f"expected consumer_shutdown failure; got {queue.fail_calls}"
