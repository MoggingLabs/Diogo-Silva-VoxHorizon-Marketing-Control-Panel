"""Tests for the Hermes kanban worker routes (HI-3 / Wave 18).

The service layer (test_hermes_kanban.py) covers parse + dispatch +
Supabase mirror. This file exercises the HTTP framing:

* bearer auth on every route,
* request validation,
* response shapes,
* SSE wrapping + heartbeat on the events endpoint,
* HermesKanbanError → 502 translation,
* the lazy service singleton + set_service test helper.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient


SHARED_SECRET = "test-secret-for-hermes-kanban-route"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "test-service-role-key")

    from src.config import get_settings
    from src.routes import hermes_kanban as hk_route

    get_settings.cache_clear()
    hk_route.set_service(None)
    yield
    get_settings.cache_clear()
    hk_route.set_service(None)


# ---------------------------------------------------------------------------
# Fake service
# ---------------------------------------------------------------------------


class _FakeService:
    """Records calls + returns scripted values.

    Mirrors the public surface of HermesKanbanService used by the
    route. Side-effects like Supabase mirroring are handled by the
    real service in test_hermes_kanban.py; this fake just maps inputs
    to outputs.
    """

    def __init__(
        self,
        *,
        create_result: str = "fake-task-id",
        show_result: Any = None,
        tail_events: list[dict[str, Any]] | None = None,
        raise_on: dict[str, Any] | None = None,
    ) -> None:
        self.create_result = create_result
        self.show_result = show_result
        self.tail_events_list = tail_events or []
        self.raise_on = raise_on or {}
        self.calls: list[dict[str, Any]] = []
        # Reset hooks for inspection
        self.cancel_calls = 0
        self.retry_calls = 0

    def _maybe_raise(self, op: str) -> None:
        if op in self.raise_on:
            raise self.raise_on[op]

    async def create_task(
        self,
        title: str,
        assignee: str = "ekko",
        context: dict[str, Any] | None = None,
        parent_id: str | None = None,
        *,
        board: str | None = None,
    ) -> str:
        self.calls.append(
            {
                "op": "create",
                "title": title,
                "assignee": assignee,
                "context": context,
                "parent_id": parent_id,
                "board": board,
            }
        )
        self._maybe_raise("create")
        return self.create_result

    async def show_task(self, task_id: str) -> Any:
        self.calls.append({"op": "show", "task_id": task_id})
        self._maybe_raise("show")
        if self.show_result is not None:
            return self.show_result
        from src.services.hermes_kanban import HermesTask

        return HermesTask(
            task_id=task_id,
            status="running",
            assignee="ekko",
            title="fake",
            context={"hello": "world"},
        )

    async def cancel_task(self, task_id: str) -> None:
        self.cancel_calls += 1
        self.calls.append({"op": "cancel", "task_id": task_id})
        self._maybe_raise("cancel")

    async def retry_task(self, task_id: str) -> None:
        self.retry_calls += 1
        self.calls.append({"op": "retry", "task_id": task_id})
        self._maybe_raise("retry")

    async def tail_events(self, task_id: str) -> AsyncIterator[dict[str, Any]]:
        self.calls.append({"op": "tail", "task_id": task_id})
        for event in self.tail_events_list:
            yield event


@pytest.fixture
def client() -> TestClient:
    """Build a TestClient with only the kanban router mounted.

    Agent D wires the router into the main app in HI-5; until that lands
    we mount the router on a small test-only FastAPI app so the route
    tests don't depend on the main app construction order. This keeps
    the test independent of the wiring change.
    """
    from fastapi import FastAPI

    from src.routes import hermes_kanban as hk_route

    app = FastAPI()
    app.include_router(hk_route.router)
    return TestClient(app)


def _install_service(svc: _FakeService) -> None:
    from src.routes import hermes_kanban as hk_route

    hk_route.set_service(svc)  # type: ignore[arg-type]


# ===========================================================================
# Auth
# ===========================================================================


def test_create_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/hermes/kanban", json={"title": "x"})
    assert resp.status_code == 401


def test_show_requires_auth(client: TestClient) -> None:
    resp = client.get("/work/hermes/kanban/t-1")
    assert resp.status_code == 401


def test_cancel_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/hermes/kanban/t-1/cancel")
    assert resp.status_code == 401


def test_retry_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/hermes/kanban/t-1/retry")
    assert resp.status_code == 401


def test_events_requires_auth(client: TestClient) -> None:
    resp = client.get("/work/hermes/kanban/t-1/events")
    assert resp.status_code == 401


# ===========================================================================
# POST /work/hermes/kanban — create
# ===========================================================================


def test_create_happy_path(client: TestClient) -> None:
    svc = _FakeService(create_result="task-001")
    _install_service(svc)
    resp = client.post(
        "/work/hermes/kanban",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "title": "Refresh audience",
            "assignee": "ekko",
            "context": {"pipeline_id": "pipe-1"},
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "task_id": "task-001",
        "assignee": "ekko",
        "board": "voxhorizon",
    }
    assert svc.calls[0]["title"] == "Refresh audience"
    assert svc.calls[0]["context"] == {"pipeline_id": "pipe-1"}


def test_create_with_explicit_board(client: TestClient) -> None:
    svc = _FakeService(create_result="task-002")
    _install_service(svc)
    resp = client.post(
        "/work/hermes/kanban",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"title": "t", "board": "audits"},
    )
    assert resp.status_code == 200
    assert resp.json()["board"] == "audits"
    assert svc.calls[0]["board"] == "audits"


def test_create_passes_parent_id(client: TestClient) -> None:
    svc = _FakeService(create_result="child-1")
    _install_service(svc)
    resp = client.post(
        "/work/hermes/kanban",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"title": "child", "parent_id": "parent-1"},
    )
    assert resp.status_code == 200
    assert svc.calls[0]["parent_id"] == "parent-1"


def test_create_rejects_empty_title(client: TestClient) -> None:
    svc = _FakeService()
    _install_service(svc)
    resp = client.post(
        "/work/hermes/kanban",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"title": ""},
    )
    assert resp.status_code == 422


def test_create_service_error_returns_502(client: TestClient) -> None:
    from src.services.hermes_kanban import HermesKanbanError

    svc = _FakeService(
        raise_on={
            "create": HermesKanbanError(
                "boom", exit_code=2, stdout="out", stderr="err"
            )
        }
    )
    _install_service(svc)
    resp = client.post(
        "/work/hermes/kanban",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"title": "x"},
    )
    assert resp.status_code == 502
    detail = resp.json()["detail"]
    assert detail["exit_code"] == 2
    assert detail["stdout"] == "out"
    assert detail["stderr"] == "err"


# ===========================================================================
# GET /work/hermes/kanban/{task_id}
# ===========================================================================


def test_show_happy_path(client: TestClient) -> None:
    from src.services.hermes_kanban import HermesTask

    svc = _FakeService(
        show_result=HermesTask(
            task_id="t-1",
            status="running",
            assignee="ekko",
            title="x",
            context={"k": "v"},
            comments=[{"author": "ekko", "body": "ack"}],
            events=[{"kind": "claimed"}],
        )
    )
    _install_service(svc)
    resp = client.get(
        "/work/hermes/kanban/t-1",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["task_id"] == "t-1"
    assert body["status"] == "running"
    assert body["context"] == {"k": "v"}
    assert body["comments"][0]["body"] == "ack"


def test_show_service_error_returns_502(client: TestClient) -> None:
    from src.services.hermes_kanban import HermesKanbanError

    svc = _FakeService(
        raise_on={"show": HermesKanbanError("nope", exit_code=4)}
    )
    _install_service(svc)
    resp = client.get(
        "/work/hermes/kanban/t-1",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
    )
    assert resp.status_code == 502


# ===========================================================================
# POST /work/hermes/kanban/{task_id}/cancel
# ===========================================================================


def test_cancel_happy_path(client: TestClient) -> None:
    svc = _FakeService()
    _install_service(svc)
    resp = client.post(
        "/work/hermes/kanban/t-1/cancel",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"task_id": "t-1", "action": "cancel", "ok": True}
    assert svc.cancel_calls == 1


def test_cancel_service_error_returns_502(client: TestClient) -> None:
    from src.services.hermes_kanban import HermesKanbanError

    svc = _FakeService(raise_on={"cancel": HermesKanbanError("err")})
    _install_service(svc)
    resp = client.post(
        "/work/hermes/kanban/t-1/cancel",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
    )
    assert resp.status_code == 502


# ===========================================================================
# POST /work/hermes/kanban/{task_id}/retry
# ===========================================================================


def test_retry_happy_path(client: TestClient) -> None:
    svc = _FakeService()
    _install_service(svc)
    resp = client.post(
        "/work/hermes/kanban/t-1/retry",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"task_id": "t-1", "action": "retry", "ok": True}
    assert svc.retry_calls == 1


def test_retry_service_error_returns_502(client: TestClient) -> None:
    from src.services.hermes_kanban import HermesKanbanError

    svc = _FakeService(raise_on={"retry": HermesKanbanError("err")})
    _install_service(svc)
    resp = client.post(
        "/work/hermes/kanban/t-1/retry",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
    )
    assert resp.status_code == 502


# ===========================================================================
# GET /work/hermes/kanban/{task_id}/events — SSE stream
# ===========================================================================


def _parse_sse_data_frames(body: str) -> list[dict[str, Any]]:
    """Pull ``data: <json>`` payloads out of an SSE body."""
    frames: list[dict[str, Any]] = []
    for raw in body.split("\n\n"):
        for line in raw.splitlines():
            if line.startswith("data:"):
                payload = line.removeprefix("data:").strip()
                if not payload:
                    continue
                try:
                    frames.append(json.loads(payload))
                except json.JSONDecodeError:
                    continue
    return frames


def test_events_streams_each_event_as_sse_frame(client: TestClient) -> None:
    svc = _FakeService(
        tail_events=[
            {"kind": "claimed"},
            {"kind": "running"},
            {"kind": "completed"},
        ]
    )
    _install_service(svc)
    resp = client.get(
        "/work/hermes/kanban/t-1/events",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    frames = _parse_sse_data_frames(resp.text)
    # First N frames are the kanban events; the final frame is the stream_end marker.
    assert [f.get("kind") for f in frames[:3]] == ["claimed", "running", "completed"]
    assert frames[-1] == {"type": "stream_end"}


def test_events_emits_stream_end_when_iterator_empty(client: TestClient) -> None:
    svc = _FakeService(tail_events=[])
    _install_service(svc)
    resp = client.get(
        "/work/hermes/kanban/t-1/events",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
    )
    assert resp.status_code == 200
    frames = _parse_sse_data_frames(resp.text)
    assert frames == [{"type": "stream_end"}]


# ===========================================================================
# SSE heartbeat — direct iterator drive
# ===========================================================================


@pytest.mark.asyncio
async def test_sse_wrap_emits_heartbeat_on_quiet_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A slow upstream triggers a ``: keepalive`` line every interval."""
    from src.routes import hermes_kanban as hk_route

    # Bring the heartbeat interval down so the test runs fast.
    monkeypatch.setattr(hk_route, "_HEARTBEAT_INTERVAL_S", 0.05)

    class _SlowService:
        async def tail_events(self, task_id: str) -> AsyncIterator[dict[str, Any]]:
            await asyncio.sleep(0.15)
            yield {"kind": "running"}

    chunks: list[bytes] = []
    async for chunk in hk_route._sse_wrap(_SlowService(), "t-1"):  # type: ignore[arg-type]
        chunks.append(chunk)
        if len(chunks) >= 4:
            break
    text = b"".join(chunks).decode()
    assert ": keepalive" in text
    # At least one heartbeat fired before the event landed.
    assert text.index(": keepalive") < text.find('"kind": "running"')


@pytest.mark.asyncio
async def test_sse_wrap_passes_through_producer_exception() -> None:
    """If the upstream iterator raises, the wrapper still emits stream_end."""
    from src.routes import hermes_kanban as hk_route

    class _BoomService:
        async def tail_events(self, task_id: str) -> AsyncIterator[dict[str, Any]]:
            yield {"kind": "ok"}
            raise RuntimeError("upstream died")

    out = b""
    async for chunk in hk_route._sse_wrap(_BoomService(), "t-1"):  # type: ignore[arg-type]
        out += chunk
    text = out.decode()
    assert '"kind": "ok"' in text
    assert "stream_end" in text


# ===========================================================================
# Service singleton helpers
# ===========================================================================


def test_set_service_swaps_singleton() -> None:
    from src.routes import hermes_kanban as hk_route

    svc1 = _FakeService()
    hk_route.set_service(svc1)  # type: ignore[arg-type]
    assert hk_route._get_service() is svc1  # type: ignore[comparison-overlap]
    hk_route.set_service(None)
    # After clearing, the next call would build a real one; we don't
    # exercise that here to avoid pulling docker SDK in.
    assert hk_route._service is None


def test_get_service_builds_real_when_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When no fake is installed, _get_service builds a real bridge+service.

    We monkeypatch HermesBridge so the constructor doesn't try to reach
    the docker daemon. The test verifies the import path: the route
    imports hermes_bridge lazily on first call.
    """
    from src.routes import hermes_kanban as hk_route
    from src.services import hermes_kanban as hk_service_mod

    hk_route.set_service(None)

    # Install a tiny fake module so the lazy ``from ..services.hermes_bridge
    # import HermesBridge`` resolves without docker. We monkeypatch at
    # ``sys.modules`` level since the import inside _get_service runs after.
    import sys
    import types as _types

    fake_module = _types.ModuleType("src.services.hermes_bridge")

    class _FakeBridge:
        def __init__(self) -> None:
            self.constructed = True

        def _container(self) -> Any:
            raise NotImplementedError("not reached in this test")

    fake_module.HermesBridge = _FakeBridge  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "src.services.hermes_bridge", fake_module)
    # Also handle the relative-import path used inside the route function.
    monkeypatch.setitem(
        sys.modules,
        f"{hk_service_mod.__name__.rsplit('.', 1)[0]}.hermes_bridge",
        fake_module,
    )

    svc = hk_route._get_service()
    assert isinstance(svc, hk_service_mod.HermesKanbanService)
    # Subsequent calls return the same instance.
    assert hk_route._get_service() is svc


# ===========================================================================
# Service-error translation
# ===========================================================================


def test_service_error_translation_truncates_long_output() -> None:
    """stdout/stderr longer than 1000 chars are truncated for the 502 body."""
    from src.routes.hermes_kanban import _service_error_to_http
    from src.services.hermes_kanban import HermesKanbanError

    big = "x" * 5000
    exc = HermesKanbanError("boom", exit_code=1, stdout=big, stderr=big)
    http_exc = _service_error_to_http(exc)
    assert http_exc.status_code == 502
    detail = http_exc.detail
    assert len(detail["stdout"]) == 1000
    assert len(detail["stderr"]) == 1000


def test_service_error_translation_handles_none_streams() -> None:
    """None stdout/stderr coerce to empty strings without breaking slicing."""
    from src.routes.hermes_kanban import _service_error_to_http
    from src.services.hermes_kanban import HermesKanbanError

    exc = HermesKanbanError("boom", exit_code=1, stdout=None, stderr=None)
    http_exc = _service_error_to_http(exc)
    assert http_exc.detail["stdout"] == ""
    assert http_exc.detail["stderr"] == ""
