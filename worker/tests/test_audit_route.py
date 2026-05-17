"""Tests for /work/audit/run + /work/audit/video routes.

The routes are thin wrappers around :func:`audit_pull.run_audit` — we mock
the orchestrator and assert auth + 503 fallback + happy-path response shape.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient


SHARED_SECRET = "test-secret-for-audit-route-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")

    from src.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client() -> TestClient:
    from src.main import create_app

    return TestClient(create_app())


def _report(format: str = "image", **over: object):
    from src.services.audit_pull import AuditReport

    defaults: dict = {
        "format": format,
        "window_days": 7,
        "clients_processed": 2,
        "rows_processed": 5,
        "rows_upserted": 4,
        "kills": 1,
        "notifications_emitted": 1,
        "errors": [],
    }
    defaults.update(over)
    return AuditReport(**defaults)


# ---------------------------------------------------------------------------
# Auth gate
# ---------------------------------------------------------------------------


def test_image_audit_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/audit/run", json={})
    assert resp.status_code == 401


def test_video_audit_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/audit/video", json={})
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Happy path — image
# ---------------------------------------------------------------------------


def test_image_audit_returns_report_on_success(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.routes import audit as audit_route

    fake = AsyncMock(return_value=_report(format="image"))
    monkeypatch.setattr(audit_route, "run_audit", fake)

    resp = client.post(
        "/work/audit/run",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"window_days": 7},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["format"] == "image"
    assert body["window_days"] == 7
    assert body["clients_processed"] == 2
    assert body["rows_processed"] == 5
    assert body["rows_upserted"] == 4
    assert body["kills"] == 1
    assert body["notifications_emitted"] == 1
    assert body["errors"] == []

    # The orchestrator was called with the right format + window.
    fake.assert_awaited_once()
    kwargs = fake.await_args.kwargs
    assert kwargs["format"] == "image"
    assert kwargs["window_days"] == 7


def test_image_audit_defaults_window_to_30(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Body omits ``window_days`` → default of 30 propagates."""
    from src.routes import audit as audit_route

    fake = AsyncMock(return_value=_report(format="image", window_days=30))
    monkeypatch.setattr(audit_route, "run_audit", fake)

    resp = client.post(
        "/work/audit/run",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert fake.await_args.kwargs["window_days"] == 30


def test_image_audit_passes_client_id_through(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.routes import audit as audit_route

    fake = AsyncMock(return_value=_report(format="image"))
    monkeypatch.setattr(audit_route, "run_audit", fake)

    resp = client.post(
        "/work/audit/run",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"window_days": 7, "client_id": "client-xyz"},
    )
    assert resp.status_code == 200, resp.text
    assert fake.await_args.kwargs["client_id"] == "client-xyz"


def test_image_audit_rejects_unsupported_window(client: TestClient) -> None:
    """Schema-level validation: window_days is Literal[1, 7, 30]."""
    resp = client.post(
        "/work/audit/run",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"window_days": 14},
    )
    # Pydantic returns 422 for value errors.
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Happy path — video
# ---------------------------------------------------------------------------


def test_video_audit_returns_report_on_success(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.routes import audit as audit_route

    fake = AsyncMock(return_value=_report(format="video", window_days=30, kills=2))
    monkeypatch.setattr(audit_route, "run_audit", fake)

    resp = client.post(
        "/work/audit/video",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"window_days": 30},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["format"] == "video"
    assert body["window_days"] == 30
    assert body["kills"] == 2

    fake.assert_awaited_once()
    assert fake.await_args.kwargs["format"] == "video"
    assert fake.await_args.kwargs["window_days"] == 30


def test_video_audit_passes_client_id(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.routes import audit as audit_route

    fake = AsyncMock(return_value=_report(format="video"))
    monkeypatch.setattr(audit_route, "run_audit", fake)

    resp = client.post(
        "/work/audit/video",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"window_days": 1, "client_id": "vc-1"},
    )
    assert resp.status_code == 200, resp.text
    assert fake.await_args.kwargs["client_id"] == "vc-1"


# ---------------------------------------------------------------------------
# 503 fallback when upstream env vars are unset
# ---------------------------------------------------------------------------


def test_image_audit_returns_503_when_upstream_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``run_audit`` raising RuntimeError → 503 (configure tokens)."""
    from src.routes import audit as audit_route

    async def boom(**_kw: object) -> None:
        raise RuntimeError("META_ADS_API_KEY must be set")

    monkeypatch.setattr(audit_route, "run_audit", boom)

    resp = client.post(
        "/work/audit/run",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"window_days": 7},
    )
    assert resp.status_code == 503
    assert "META_ADS_API_KEY" in resp.json()["detail"]


def test_video_audit_returns_503_when_upstream_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same as the image variant — the video route surfaces RuntimeErrors as 503."""
    from src.routes import audit as audit_route

    async def boom(**_kw: object) -> None:
        raise RuntimeError("GHL_API_KEY missing")

    monkeypatch.setattr(audit_route, "run_audit", boom)

    resp = client.post(
        "/work/audit/video",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"window_days": 7},
    )
    assert resp.status_code == 503
    assert "GHL_API_KEY" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Errors propagate to the AuditRunResult body
# ---------------------------------------------------------------------------


def test_image_audit_surfaces_per_client_errors_in_body(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.routes import audit as audit_route

    fake = AsyncMock(
        return_value=_report(
            format="image",
            errors=["acme: meta 403", "beta: meta 500"],
        )
    )
    monkeypatch.setattr(audit_route, "run_audit", fake)

    resp = client.post(
        "/work/audit/run",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"window_days": 7},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["errors"] == ["acme: meta 403", "beta: meta 500"]
