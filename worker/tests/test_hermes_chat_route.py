"""Tests for :mod:`worker.src.routes.hermes_chat`.

Exercises the FastAPI router directly with a fresh ``TestClient`` and
a fake :class:`HermesBridge` to keep tests off the Docker socket.
The route is wired into a minimal app in this test (rather than
``src.main.create_app``) because Agent D owns the main wiring change;
tests pinning behaviour through the router itself stay decoupled.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.routes import hermes_chat
from src.services.hermes_bridge import HermesBridgeError


SHARED_SECRET = "test-secret-for-hermes-chat-route"


# ---------------------------------------------------------------------------
# Environment + bridge fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Stand up the env vars ``Settings`` requires + reset the bridge."""
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")

    from src.config import get_settings

    get_settings.cache_clear()
    hermes_chat._reset_bridge()
    yield
    get_settings.cache_clear()
    hermes_chat._reset_bridge()


@pytest.fixture
def app() -> FastAPI:
    """Minimal FastAPI app with only the hermes router mounted."""
    app = FastAPI()
    app.include_router(hermes_chat.router)
    return app


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


# ---------------------------------------------------------------------------
# Fake bridge — covers chat_stream + abort surfaces
# ---------------------------------------------------------------------------


class _FakeBridge:
    """Stand-in :class:`HermesBridge` controllable from each test."""

    def __init__(
        self,
        chunks: list[bytes] | None = None,
        stream_raises: Exception | None = None,
        abort_result: bool = True,
    ) -> None:
        self.chunks = chunks or [b"hello"]
        self.stream_raises = stream_raises
        self.abort_result = abort_result
        self.calls: list[dict[str, Any]] = []
        self.abort_calls: list[str] = []

    async def chat_stream(
        self,
        prompt: str,
        session_id: str | None = None,
        system_prompt: str | None = None,
    ) -> AsyncIterator[bytes]:
        self.calls.append(
            {
                "prompt": prompt,
                "session_id": session_id,
                "system_prompt": system_prompt,
            }
        )
        if self.stream_raises:
            raise self.stream_raises
        for c in self.chunks:
            yield c
            await asyncio.sleep(0)

    async def abort(self, session_id: str) -> bool:
        self.abort_calls.append(session_id)
        return self.abort_result


# ---------------------------------------------------------------------------
# Singleton plumbing
# ---------------------------------------------------------------------------


def test_get_bridge_constructs_lazily_then_reuses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """First call instantiates HermesBridge; second returns the same one."""
    from src.services import hermes_bridge as bridge_mod

    constructed: list[bridge_mod.HermesBridge] = []

    class _NoopClient:
        api = object()

        class containers:
            @staticmethod
            def get(name: str) -> object:
                return object()

    def _factory() -> _NoopClient:
        return _NoopClient()

    monkeypatch.setattr(bridge_mod.docker, "from_env", _factory)

    hermes_chat._reset_bridge()
    b1 = hermes_chat._get_bridge()
    b2 = hermes_chat._get_bridge()
    assert b1 is b2
    constructed.append(b1)
    hermes_chat._reset_bridge()
    assert hermes_chat._bridge is None


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def test_chat_requires_auth(client: TestClient) -> None:
    resp = client.post(
        "/work/hermes/chat",
        json={
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert resp.status_code == 401


def test_abort_requires_auth(client: TestClient) -> None:
    resp = client.post(
        "/work/hermes/chat/abort",
        json={"session_id": "s-1"},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


def test_chat_returns_422_when_body_malformed(client: TestClient) -> None:
    resp = client.post(
        "/work/hermes/chat",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"oops": "no messages"},
    )
    assert resp.status_code == 422


def test_chat_returns_422_when_message_content_blank(client: TestClient) -> None:
    resp = client.post(
        "/work/hermes/chat",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"messages": [{"role": "user", "content": ""}]},
    )
    assert resp.status_code == 422


def test_abort_returns_422_when_session_id_missing(client: TestClient) -> None:
    resp = client.post(
        "/work/hermes/chat/abort",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={},
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Happy path SSE stream
# ---------------------------------------------------------------------------


def _parse_sse(body: bytes) -> list[dict]:
    """Split an SSE response body into decoded JSON frames."""
    out: list[dict] = []
    for line in body.split(b"\n\n"):
        line = line.strip()
        if not line:
            continue
        if line.startswith(b"data: "):
            out.append(json.loads(line[len(b"data: ") :]))
    return out


def test_chat_streams_text_deltas_and_terminal_frame(
    client: TestClient,
) -> None:
    fake = _FakeBridge(chunks=[b"hello ", b"world"])
    hermes_chat._bridge = fake  # type: ignore[assignment]

    with client.stream(
        "POST",
        "/work/hermes/chat",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "messages": [
                {"role": "system", "content": "you are helpful"},
                {"role": "user", "content": "say hi"},
            ],
            "session_id": "sess-1",
            "system_prompt": "be brief",
        },
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = b"".join(resp.iter_bytes())

    frames = _parse_sse(body)
    types = [f["type"] for f in frames]
    assert types == ["text_delta", "text_delta", "message_stop"]
    assert frames[0]["delta"] == "hello "
    assert frames[1]["delta"] == "world"

    # The bridge saw the last user message + the passthrough fields.
    assert fake.calls == [
        {
            "prompt": "say hi",
            "session_id": "sess-1",
            "system_prompt": "be brief",
        }
    ]


def test_chat_picks_last_user_message_when_history_present(
    client: TestClient,
) -> None:
    fake = _FakeBridge(chunks=[b"reply"])
    hermes_chat._bridge = fake  # type: ignore[assignment]

    with client.stream(
        "POST",
        "/work/hermes/chat",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "messages": [
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "first-reply"},
                {"role": "user", "content": "second"},
            ],
        },
    ) as resp:
        b"".join(resp.iter_bytes())

    assert fake.calls[0]["prompt"] == "second"


def test_chat_emits_only_message_stop_when_no_user_message(
    client: TestClient,
) -> None:
    """Assistant-only history → nothing to forward to Hermes."""
    fake = _FakeBridge()
    hermes_chat._bridge = fake  # type: ignore[assignment]

    with client.stream(
        "POST",
        "/work/hermes/chat",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"messages": [{"role": "assistant", "content": "hi"}]},
    ) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes())

    frames = _parse_sse(body)
    assert frames == [{"type": "message_stop"}]
    # Bridge was never invoked.
    assert fake.calls == []


def test_chat_replaces_invalid_utf8_in_chunks(client: TestClient) -> None:
    """Non-UTF8 bytes should pass through with the ``replace`` errors mode."""
    fake = _FakeBridge(chunks=[b"\xff\xfehey"])
    hermes_chat._bridge = fake  # type: ignore[assignment]

    with client.stream(
        "POST",
        "/work/hermes/chat",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"messages": [{"role": "user", "content": "x"}]},
    ) as resp:
        body = b"".join(resp.iter_bytes())

    frames = _parse_sse(body)
    assert frames[0]["type"] == "text_delta"
    # ``replace`` mode means the invalid bytes are substituted with U+FFFD.
    assert "hey" in frames[0]["delta"]


# ---------------------------------------------------------------------------
# Error frame
# ---------------------------------------------------------------------------


def test_chat_emits_error_frame_when_bridge_raises(client: TestClient) -> None:
    fake = _FakeBridge(stream_raises=HermesBridgeError("container is down"))
    hermes_chat._bridge = fake  # type: ignore[assignment]

    with client.stream(
        "POST",
        "/work/hermes/chat",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "messages": [{"role": "user", "content": "anything"}],
        },
    ) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes())

    frames = _parse_sse(body)
    assert frames == [
        {"type": "error", "message": "container is down"},
        {"type": "message_stop"},
    ]


# ---------------------------------------------------------------------------
# Abort route
# ---------------------------------------------------------------------------


def test_abort_returns_200_when_exec_signalled(client: TestClient) -> None:
    fake = _FakeBridge(abort_result=True)
    hermes_chat._bridge = fake  # type: ignore[assignment]

    resp = client.post(
        "/work/hermes/chat/abort",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"session_id": "sess-K"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"aborted": True}
    assert fake.abort_calls == ["sess-K"]


def test_abort_returns_404_when_no_live_session(client: TestClient) -> None:
    fake = _FakeBridge(abort_result=False)
    hermes_chat._bridge = fake  # type: ignore[assignment]

    resp = client.post(
        "/work/hermes/chat/abort",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"session_id": "sess-gone"},
    )
    assert resp.status_code == 404
    assert resp.json() == {"aborted": False}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def test_sse_helper_encodes_data_frame() -> None:
    line = hermes_chat._sse({"type": "x", "v": 1})
    assert line == b'data: {"type": "x", "v": 1}\n\n'


def test_last_user_message_returns_empty_when_no_user() -> None:
    msgs = [hermes_chat.ChatMessage(role="assistant", content="hello")]
    assert hermes_chat._last_user_message(msgs) == ""


def test_last_user_message_skips_assistants_to_find_latest_user() -> None:
    msgs = [
        hermes_chat.ChatMessage(role="user", content="one"),
        hermes_chat.ChatMessage(role="assistant", content="ack"),
        hermes_chat.ChatMessage(role="user", content="two"),
    ]
    assert hermes_chat._last_user_message(msgs) == "two"
