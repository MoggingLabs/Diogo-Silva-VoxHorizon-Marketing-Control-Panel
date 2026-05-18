"""Tests for the plugin entry point — ``register(ctx)`` + ``pre_tool_call``.

We construct a minimal fake plugin host, register the hook, then call
the captured handler with various inputs to exercise every branch:

* Allowlisted tool — pass-through.
* Cached approval — pass-through.
* Operator approves — pass-through, cache populated.
* Operator rejects — block returned with the operator's reason.
* HTTP error — fail-closed block with the underlying error.
* Worker URL unset — fail-closed.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from voxhorizon_approvals import register
from voxhorizon_approvals.audit import AUDIT_LOG_PATH_ENV
from voxhorizon_approvals.client import (
    ApprovalClient,
    ApprovalVerdict,
)


# ---------------------------------------------------------------------------
# Test scaffolding
# ---------------------------------------------------------------------------


class FakeCtx:
    """Captures hook registrations the way Hermes would call them."""

    def __init__(self) -> None:
        self.hooks: dict[str, Any] = {}

    def register_hook(self, name: str, handler: Any) -> None:
        # Last write wins — match Hermes' behaviour.
        self.hooks[name] = handler


@pytest.fixture
def audit_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    p = tmp_path / "audit.jsonl"
    monkeypatch.setenv(AUDIT_LOG_PATH_ENV, str(p))
    return p


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "VOXHORIZON_APPROVAL_WORKER_URL", "http://worker.test:8000"
    )
    monkeypatch.setenv("VOXHORIZON_APPROVAL_TOKEN", "test-token")


def _register_with_mock(
    handler,
) -> tuple[FakeCtx, Any, ApprovalClient]:
    """Build a plugin instance whose client uses an httpx MockTransport.

    Returns ``(ctx, hook, client)`` so individual tests can call the
    hook directly and inspect the cache afterward.
    """
    ctx = FakeCtx()
    register(ctx)
    hook = ctx.hooks["pre_tool_call"]

    # Swap the auto-built client with one wired to a mock transport.
    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport)
    mock_client = ApprovalClient(
        worker_url="http://worker.test:8000",
        token="test-token",
        default_timeout_s=10,
        http_client=http,
    )

    # ``register`` captures the original client in its closure. The
    # cleanest hot-swap is to monkey-patch the bound name back via the
    # hook's ``__closure__``. CPython exposes the closure cells via
    # ``__closure__`` + ``__code__.co_freevars``.
    freevars = hook.__code__.co_freevars
    closure = hook.__closure__ or ()
    for var_name, cell in zip(freevars, closure):
        if var_name == "client":
            cell.cell_contents = mock_client
            break
    else:  # pragma: no cover - defensive
        raise AssertionError("register() must close over ``client``")

    return ctx, hook, mock_client


# ---------------------------------------------------------------------------
# register()
# ---------------------------------------------------------------------------


def test_register_wires_pre_tool_call_hook(env: None) -> None:
    ctx = FakeCtx()
    register(ctx)
    assert "pre_tool_call" in ctx.hooks
    assert callable(ctx.hooks["pre_tool_call"])


def test_register_only_wires_one_hook(env: None) -> None:
    ctx = FakeCtx()
    register(ctx)
    # Wave 20's scope is the single ``pre_tool_call`` gate; extra hooks
    # would suggest scope creep.
    assert set(ctx.hooks) == {"pre_tool_call"}


# ---------------------------------------------------------------------------
# Allowlist / cache / operator approve / reject / error branches
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_allowlisted_tool_is_passthrough(
    env: None, audit_path: Path
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(
            "allowlisted tool must not reach the worker"
        )

    _ctx, hook, _client = _register_with_mock(handler)
    result = await hook("read_file", {"path": "/etc/hosts"}, "task-1")
    assert result is None

    # Audit row should be present with decision=allow.
    rows = [
        json.loads(line)
        for line in audit_path.read_text(encoding="utf-8").splitlines()
    ]
    assert len(rows) == 1
    assert rows[0]["tool"] == "read_file"
    assert rows[0]["decision"] == "allow"
    assert "latency_ms" in rows[0]


@pytest.mark.asyncio
async def test_safe_shell_command_is_passthrough(env: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("safe shell must not reach the worker")

    _ctx, hook, _client = _register_with_mock(handler)
    result = await hook(
        "shell_command",
        {"command": "git status"},
        "task-1",
        session_id="sess-1",
    )
    assert result is None


@pytest.mark.asyncio
async def test_operator_approves_is_passthrough_and_caches(
    env: None, audit_path: Path
) -> None:
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(
            200, json={"decision": "approved", "notes": "go"}
        )

    _ctx, hook, client = _register_with_mock(handler)

    # First call hits the worker.
    result1 = await hook(
        "kie_generate",
        {"prompt": "x"},
        "task-1",
        session_id="sess-1",
        tool_call_id="tc-1",
    )
    assert result1 is None
    assert calls["count"] == 1

    # Second identical call hits the cache.
    result2 = await hook(
        "kie_generate",
        {"prompt": "x"},
        "task-2",
        session_id="sess-1",
        tool_call_id="tc-2",
    )
    assert result2 is None
    assert calls["count"] == 1, "cache should have absorbed the second call"

    # Cache is populated.
    assert (
        client.cache_get("sess-1", "kie_generate", {"prompt": "x"}) is not None
    )

    rows = [
        json.loads(line)
        for line in audit_path.read_text(encoding="utf-8").splitlines()
    ]
    assert len(rows) == 2
    assert rows[0]["decision"] == "approved"
    assert rows[1]["decision"] == "approved"
    assert "cached" in rows[1]["reason"]


@pytest.mark.asyncio
async def test_operator_rejects_returns_block(
    env: None, audit_path: Path
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"decision": "rejected", "notes": "spend cap"}
        )

    _ctx, hook, _client = _register_with_mock(handler)
    result = await hook(
        "send_email",
        {"to": "x"},
        "task-1",
        session_id="sess-1",
        tool_call_id="tc-1",
    )
    assert result == {
        "action": "block",
        "message": "Operator denied: spend cap",
    }

    rows = [
        json.loads(line)
        for line in audit_path.read_text(encoding="utf-8").splitlines()
    ]
    assert rows[0]["decision"] == "blocked"
    assert "spend cap" in rows[0]["reason"]


@pytest.mark.asyncio
async def test_operator_rejects_without_notes(env: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"decision": "rejected", "notes": None}
        )

    _ctx, hook, _client = _register_with_mock(handler)
    result = await hook(
        "send_email", {"to": "x"}, "task-1", session_id="sess-1"
    )
    assert result is not None
    assert result["action"] == "block"
    assert "no reason given" in result["message"]


@pytest.mark.asyncio
async def test_worker_unreachable_fails_closed(
    env: None, audit_path: Path
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failure", request=request)

    _ctx, hook, _client = _register_with_mock(handler)
    result = await hook(
        "send_email",
        {"to": "x"},
        "task-1",
        session_id="sess-1",
        tool_call_id="tc-1",
    )
    assert result is not None
    assert result["action"] == "block"
    assert "fail-closed" in result["message"]

    rows = [
        json.loads(line)
        for line in audit_path.read_text(encoding="utf-8").splitlines()
    ]
    assert rows[0]["decision"] == "blocked"
    assert "plugin error" in rows[0]["reason"]


@pytest.mark.asyncio
async def test_destructive_shell_asks_operator(env: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        # rm -rf goes through the operator even if shell_command is wired.
        return httpx.Response(
            200, json={"decision": "rejected", "notes": "nope"}
        )

    _ctx, hook, _client = _register_with_mock(handler)
    result = await hook(
        "shell_command",
        {"command": "rm -rf /opt"},
        "task-1",
        session_id="sess-1",
    )
    assert result is not None
    assert result["action"] == "block"


@pytest.mark.asyncio
async def test_unknown_tool_asks_operator(env: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"decision": "approved", "notes": None},
        )

    _ctx, hook, _client = _register_with_mock(handler)
    result = await hook(
        "totally_made_up_tool",
        {"foo": "bar"},
        "task-1",
        session_id="sess-1",
    )
    assert result is None


@pytest.mark.asyncio
async def test_approved_with_caveat_is_passthrough(env: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "decision": "approved_with_caveat",
                "notes": "spend cap warning",
            },
        )

    _ctx, hook, _client = _register_with_mock(handler)
    result = await hook(
        "kie_generate",
        {"prompt": "ok"},
        "task-1",
        session_id="sess-1",
    )
    assert result is None


@pytest.mark.asyncio
async def test_kwargs_fallback_to_task_id(env: None) -> None:
    """When session_id/tool_call_id aren't passed, the hook falls back."""
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"decision": "approved", "notes": None}
        )

    _ctx, hook, _client = _register_with_mock(handler)
    await hook("kie_generate", {}, "task-99")
    assert captured["body"]["ekko_session_id"] == "default"
    assert captured["body"]["ekko_tool_call_id"] == "task-99"


@pytest.mark.asyncio
async def test_missing_env_var_fails_closed(
    monkeypatch: pytest.MonkeyPatch, audit_path: Path
) -> None:
    """No mock transport — the missing env raises at resolve-time."""
    monkeypatch.delenv("VOXHORIZON_APPROVAL_WORKER_URL", raising=False)
    monkeypatch.delenv("VOXHORIZON_APPROVAL_TOKEN", raising=False)

    ctx = FakeCtx()
    register(ctx)
    hook = ctx.hooks["pre_tool_call"]

    result = await hook("kie_generate", {}, "task-1", session_id="sess-1")
    assert result is not None
    assert result["action"] == "block"
    assert "fail-closed" in result["message"]


def test_register_handler_is_a_coroutine_function(env: None) -> None:
    """Hermes requires an async handler for pre_tool_call."""
    ctx = FakeCtx()
    register(ctx)
    assert asyncio.iscoroutinefunction(ctx.hooks["pre_tool_call"])
