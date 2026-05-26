"""Tests for :mod:`voxhorizon_daemon.startup`.

Pure-function tests: compose a fake QueueClient + a fake HermesExec,
call :func:`run_startup_check`, and assert the per-step ``ok`` + ``detail``.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
import respx

from voxhorizon_daemon.hermes_exec import HermesExec
from voxhorizon_daemon.queue_client import QueueClient
from voxhorizon_daemon.startup import run_startup_check
from voxhorizon_daemon.types import AuthProbeResult


BASE_URL = "http://worker.test"


class FakeHermesExec:
    """Hand-rolled double for HermesExec — no Docker needed."""

    def __init__(
        self,
        *,
        status: str,
        auth_ok: bool,
        auth_detail: dict[str, Any] | None = None,
        name: str = "hermes-agent-operator",
    ) -> None:
        self._status = status
        self._auth_ok = auth_ok
        self._auth_detail = auth_detail or {}
        self.container_name = name

    def container_status(self) -> str:
        return self._status

    async def auth_probe(self) -> AuthProbeResult:
        return AuthProbeResult(ok=self._auth_ok, detail=self._auth_detail)


async def _build_client(rmock_block) -> QueueClient:  # noqa: ANN001
    c = QueueClient(base_url=BASE_URL, secret="t", retry_attempts=1)
    await c.__aenter__()
    return c


async def test_all_three_pass():
    fake_hx = FakeHermesExec(status="running", auth_ok=True, auth_detail={"reason": "ok"})
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.get("/work/health").mock(return_value=httpx.Response(200, json={"ok": True}))
        async with QueueClient(base_url=BASE_URL, secret="t", retry_attempts=1) as qc:
            check = await run_startup_check(queue_client=qc, hermes_exec=fake_hx)  # type: ignore[arg-type]
    assert check.all_ok is True
    assert check.first_failure() is None
    assert check.queue_reachable.ok is True
    assert check.hermes_container_up.ok is True
    assert check.hermes_auth.ok is True


async def test_queue_unreachable_short_circuits():
    fake_hx = FakeHermesExec(status="running", auth_ok=True)
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.get("/work/health").mock(return_value=httpx.Response(503))
        async with QueueClient(base_url=BASE_URL, secret="t", retry_attempts=1) as qc:
            check = await run_startup_check(queue_client=qc, hermes_exec=fake_hx)  # type: ignore[arg-type]
    assert check.all_ok is False
    assert check.queue_reachable.ok is False
    # Subsequent steps are short-circuited:
    assert check.hermes_container_up.ok is False
    assert check.hermes_container_up.detail.get("reason") == "skipped_due_to_prior_failure"
    assert check.hermes_auth.detail.get("reason") == "skipped_due_to_prior_failure"
    assert check.first_failure() == "queue_reachable"


async def test_queue_auth_failure_classifies_as_auth_rejected():
    fake_hx = FakeHermesExec(status="running", auth_ok=True)
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.get("/work/health").mock(return_value=httpx.Response(401, text="bad"))
        async with QueueClient(base_url=BASE_URL, secret="t", retry_attempts=1) as qc:
            check = await run_startup_check(queue_client=qc, hermes_exec=fake_hx)  # type: ignore[arg-type]
    assert check.queue_reachable.ok is False
    assert check.queue_reachable.detail.get("reason") == "auth_rejected"


async def test_hermes_container_not_running_short_circuits_auth():
    fake_hx = FakeHermesExec(status="exited", auth_ok=True)
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.get("/work/health").mock(return_value=httpx.Response(200))
        async with QueueClient(base_url=BASE_URL, secret="t", retry_attempts=1) as qc:
            check = await run_startup_check(queue_client=qc, hermes_exec=fake_hx)  # type: ignore[arg-type]
    assert check.queue_reachable.ok is True
    assert check.hermes_container_up.ok is False
    assert check.hermes_container_up.detail.get("status") == "exited"
    assert check.hermes_auth.ok is False
    assert check.first_failure() == "hermes_container_up"


async def test_hermes_container_not_found():
    fake_hx = FakeHermesExec(status="not_found", auth_ok=True)
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.get("/work/health").mock(return_value=httpx.Response(200))
        async with QueueClient(base_url=BASE_URL, secret="t", retry_attempts=1) as qc:
            check = await run_startup_check(queue_client=qc, hermes_exec=fake_hx)  # type: ignore[arg-type]
    assert check.hermes_container_up.ok is False


async def test_auth_failed_marks_only_auth_step():
    fake_hx = FakeHermesExec(
        status="running", auth_ok=False, auth_detail={"reason": "expired"}
    )
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.get("/work/health").mock(return_value=httpx.Response(200))
        async with QueueClient(base_url=BASE_URL, secret="t", retry_attempts=1) as qc:
            check = await run_startup_check(queue_client=qc, hermes_exec=fake_hx)  # type: ignore[arg-type]
    assert check.queue_reachable.ok is True
    assert check.hermes_container_up.ok is True
    assert check.hermes_auth.ok is False
    assert check.hermes_auth.detail.get("reason") == "expired"
    assert check.first_failure() == "hermes_auth"


async def test_auth_probe_disabled_skips_probe_and_marks_ok():
    fake_hx = FakeHermesExec(status="running", auth_ok=False)
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.get("/work/health").mock(return_value=httpx.Response(200))
        async with QueueClient(base_url=BASE_URL, secret="t", retry_attempts=1) as qc:
            check = await run_startup_check(
                queue_client=qc, hermes_exec=fake_hx, auth_probe_enabled=False  # type: ignore[arg-type]
            )
    assert check.hermes_auth.ok is True
    assert check.hermes_auth.detail.get("reason") == "probe_disabled"


async def test_queue_unreachable_via_transport_error():
    fake_hx = FakeHermesExec(status="running", auth_ok=True)
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.get("/work/health").mock(side_effect=httpx.ConnectError("refused"))
        async with QueueClient(base_url=BASE_URL, secret="t", retry_attempts=1) as qc:
            check = await run_startup_check(queue_client=qc, hermes_exec=fake_hx)  # type: ignore[arg-type]
    assert check.queue_reachable.ok is False
    assert check.queue_reachable.detail.get("reason") == "unreachable"


async def test_queue_returns_false_classifies_as_non_2xx():
    """health_ping returning False (not raising) maps to 'non_2xx_response'."""
    fake_hx = FakeHermesExec(status="running", auth_ok=True)

    class _FalseHealth:
        async def health_ping(self) -> bool:
            return False

    check = await run_startup_check(queue_client=_FalseHealth(), hermes_exec=fake_hx)  # type: ignore[arg-type]
    assert check.queue_reachable.ok is False
    assert check.queue_reachable.detail.get("reason") == "non_2xx_response"


async def test_queue_unexpected_exception_classifies_as_client_error(monkeypatch: pytest.MonkeyPatch):
    """If something extra-weird happens, surface it as ``client_error``."""
    fake_hx = FakeHermesExec(status="running", auth_ok=True)

    class _BoomClient:
        async def health_ping(self) -> bool:
            raise ValueError("unexpected")

    check = await run_startup_check(queue_client=_BoomClient(), hermes_exec=fake_hx)  # type: ignore[arg-type]
    assert check.queue_reachable.ok is False
    assert check.queue_reachable.detail.get("reason") == "client_error"
