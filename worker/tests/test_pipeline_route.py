"""Tests for the pipeline config-draft route (Wave 10 / PF-B-3).

Exercises the happy path: a stubbed ClaudeRunner emits a fake
`propose_config` tool_use, the route should pass it through and
synthesize a matching `tool_call_result` frame so the front end sees
both frames on the SSE wire.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from src.services.claude_runner import ClaudeRunner, StreamChunk


SHARED_SECRET = "test-secret-for-pipeline-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Provision env + reset cached settings + runner singleton."""
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")
    # Avoid the SDK complaining when the runner is constructed by the
    # real default factory.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-api-key")

    from src.config import get_settings
    from src.routes import pipeline as pipeline_route
    from src.services.queue import reset_queue

    get_settings.cache_clear()
    reset_queue()
    pipeline_route._reset_runner()
    yield
    get_settings.cache_clear()
    reset_queue()
    pipeline_route._reset_runner()


class _FakeProposeRunner(ClaudeRunner):
    """Test double that emits a brief assistant message + a tool_use call.

    We bypass the Anthropic SDK entirely by overriding `stream` — the
    runner's transport is monkey-patched out and we drive the SSE flow
    from a hard-coded sequence of StreamChunks.
    """

    def __init__(self, payload: dict[str, Any]) -> None:
        super().__init__(anthropic_api_key="test")
        self._payload = payload

    async def stream(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        system_prompt: str | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
    ) -> AsyncIterator[StreamChunk]:
        # Short text delta so the consumer sees realistic shape.
        yield StreamChunk(type="text_delta", delta="Drafting brief…")
        # Tool invocation — the runner's _translate_event surfaces full
        # tool_use blocks as tool_call_start with the complete `input`.
        yield StreamChunk(
            type="tool_call_start",
            tool="propose_config",
            input=self._payload,
        )
        yield StreamChunk(type="message_stop")


@pytest.fixture
def client() -> TestClient:
    from src.main import create_app

    return TestClient(create_app())


def _parse_sse(body: str) -> list[dict[str, Any]]:
    """Pull `data:` JSON frames out of the SSE response body."""
    frames: list[dict[str, Any]] = []
    for raw_event in body.split("\n\n"):
        for line in raw_event.splitlines():
            if line.startswith("data:"):
                payload = line.removeprefix("data:").strip()
                if not payload:
                    continue
                frames.append(json.loads(payload))
    return frames


def test_config_draft_emits_tool_call_result(client: TestClient) -> None:
    from src.routes import pipeline as pipeline_route

    proposed: dict[str, Any] = {
        "format_choice": "image",
        "image_payload": {
            "service": "roofing",
            "budget": 5000,
            "market": "Tampa, FL",
        },
        "video_payload": None,
        "notes": "operator asked for an image-only test run",
    }
    pipeline_route._runner = _FakeProposeRunner(proposed)

    resp = client.post(
        "/work/pipeline/config-draft",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "pipeline_id": "p-test-1",
            "format_choice": "image",
            "messages": [
                {"role": "user", "content": "Draft an image brief for me."}
            ],
        },
    )

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    frames = _parse_sse(resp.text)
    # We expect at least the text delta, the tool_call_start, the
    # synthesized tool_call_result, and the message_stop.
    types = [f["type"] for f in frames]
    assert "text_delta" in types
    assert "tool_call_start" in types
    assert "tool_call_result" in types
    assert types[-1] == "message_stop"

    # The synthesized result mirrors the propose_config input verbatim.
    result_frame = next(
        f for f in frames if f["type"] == "tool_call_result"
    )
    assert result_frame["tool"] == "propose_config"
    assert result_frame["result"] == proposed


def test_config_draft_requires_auth(client: TestClient) -> None:
    resp = client.post(
        "/work/pipeline/config-draft",
        json={
            "pipeline_id": "p-test-1",
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert resp.status_code == 401


def test_config_draft_rejects_empty_messages(client: TestClient) -> None:
    resp = client.post(
        "/work/pipeline/config-draft",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "pipeline_id": "p-test-1",
            "messages": [],
        },
    )
    assert resp.status_code == 400
