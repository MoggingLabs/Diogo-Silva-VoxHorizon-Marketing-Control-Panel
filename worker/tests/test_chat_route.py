"""Tests for /work/chat — the legacy stub that hands off to M2's SSE flow.

The non-streaming POST /work/chat endpoint is intentionally a 501 — Diogo's
Claude Code subprocess path was deprecated when the SSE proxy at
``/work/chat/stream`` landed. We only need to make sure the bearer guard
still fires and the 501 body is stable.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


SHARED_SECRET = "test-secret-for-chat-route"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")

    from src.config import get_settings
    from src.services.queue import reset_queue

    get_settings.cache_clear()
    reset_queue()
    yield
    get_settings.cache_clear()
    reset_queue()


@pytest.fixture
def client() -> TestClient:
    from src.main import create_app

    return TestClient(create_app())


def test_chat_requires_auth(client: TestClient) -> None:
    """No bearer → 401, even though the body is a stub."""
    resp = client.post("/work/chat", json={})
    assert resp.status_code == 401


def test_chat_returns_501_when_authed(client: TestClient) -> None:
    """With a valid bearer, the legacy endpoint surfaces a 501.

    The non-streaming chat path was deprecated when the SSE proxy at
    ``/work/chat/stream`` landed in Wave 4.
    """
    resp = client.post(
        "/work/chat",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={},
    )
    assert resp.status_code == 501
    body = resp.json()
    assert "Not implemented" in body["detail"]
    assert "M2" in body["detail"]


def test_chat_wrong_bearer_returns_401(client: TestClient) -> None:
    resp = client.post(
        "/work/chat",
        headers={"Authorization": "Bearer not-the-secret"},
        json={},
    )
    assert resp.status_code == 401
