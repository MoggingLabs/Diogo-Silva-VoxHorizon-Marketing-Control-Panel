"""Tests for the public ``/work/ping`` liveness probe (VPS-6).

This route is the deliberate exception to the shared-secret bearer rule that
covers every other worker endpoint. External uptime monitors poll it on a
fixed interval, so it must:

* return 200 with ``{"ok": true}`` and NOTHING else (no version, no env info,
  no PII / leakage),
* succeed without any ``Authorization`` header,
* succeed even when an INVALID bearer is sent (i.e. never 401).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


SHARED_SECRET = "test-secret-for-ping-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Provision the minimum env the worker needs to construct an app."""
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
    """Fresh TestClient built against a fresh app instance."""
    from src.main import create_app

    return TestClient(create_app())


def test_ping_without_auth_returns_200_and_ok_true(client: TestClient) -> None:
    """No Authorization header, no problem — the route is intentionally public."""
    resp = client.get("/work/ping")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_ping_body_contains_only_ok_true(client: TestClient) -> None:
    """The body must NOT leak version, env, hostname, or any other field.

    Pinning the exact shape protects against drift where someone copies
    /work/health into /work/ping and accidentally exposes internal info on
    the public probe.
    """
    resp = client.get("/work/ping")
    body = resp.json()

    assert body == {"ok": True}
    # Defensive: re-assert the exact key set in case `body == {...}` ever
    # gets relaxed during a refactor.
    assert set(body.keys()) == {"ok"}


def test_ping_with_invalid_bearer_still_returns_200(client: TestClient) -> None:
    """A wrong bearer must NOT trigger 401 — this route is exempt from auth."""
    resp = client.get(
        "/work/ping",
        headers={"Authorization": "Bearer this-is-not-the-real-secret"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_ping_with_valid_bearer_also_returns_200(client: TestClient) -> None:
    """The route is indifferent to the header: with-or-without, same result."""
    resp = client.get(
        "/work/ping",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
