"""Tests for the ``/work/hermes/approval-mode`` routes (Wave 24).

Coverage targets:

* Bearer auth: valid / missing / wrong scheme / wrong token / unset env
* PUT body validation: unknown mode → 422; missing TTL for AUTO_APPROVE
  → 422; TTL on ASK / HALT → 422; out-of-range TTL → 422
* PUT happy path returns the row + writes audit
* PUT surfaces 502 on :class:`ApprovalModeError`
* GET 200 / 401 / 502
* GET /audit 200 / 401 / 502 / clamping
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.routes import hermes_approval_mode as route_module
from src.services import hermes_approval_mode as service


TOKEN = "approval-mode-test-token"


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VOXHORIZON_APPROVAL_TOKEN", TOKEN)


@pytest.fixture
def app() -> FastAPI:
    a = FastAPI()
    a.include_router(route_module.router)
    return a


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


def _valid_put_body() -> dict[str, Any]:
    return {
        "mode": "AUTO_APPROVE",
        "ttl_seconds": 3600,
        "note": "batch run",
    }


# ---------------------------------------------------------------------------
# Auth gate
# ---------------------------------------------------------------------------


def test_get_missing_authorization_returns_401(
    client: TestClient,
) -> None:
    resp = client.get("/work/hermes/approval-mode")
    assert resp.status_code == 401
    assert resp.headers.get("www-authenticate") == "Bearer"


def test_get_wrong_scheme_returns_401(client: TestClient) -> None:
    resp = client.get(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Basic {TOKEN}"},
    )
    assert resp.status_code == 401


def test_get_wrong_token_returns_401(client: TestClient) -> None:
    resp = client.get(
        "/work/hermes/approval-mode",
        headers={"Authorization": "Bearer wrong"},
    )
    assert resp.status_code == 401


def test_get_unset_token_env_rejects(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("VOXHORIZON_APPROVAL_TOKEN", raising=False)
    resp = client.get(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 401


def test_put_missing_authorization_returns_401(
    client: TestClient,
) -> None:
    resp = client.put("/work/hermes/approval-mode", json=_valid_put_body())
    assert resp.status_code == 401


def test_audit_missing_authorization_returns_401(
    client: TestClient,
) -> None:
    resp = client.get("/work/hermes/approval-mode/audit")
    assert resp.status_code == 401


def test_audit_wrong_token_returns_401(client: TestClient) -> None:
    resp = client.get(
        "/work/hermes/approval-mode/audit",
        headers={"Authorization": "Bearer wrong"},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# GET — happy path + errors
# ---------------------------------------------------------------------------


def test_get_returns_current_row(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _fake() -> service.ApprovalModeRow:
        return service.ApprovalModeRow(
            mode="HALT",
            expires_at=None,
            set_by="dashboard",
            set_at="2026-05-19T12:00:00+00:00",
            note="halt for deploy",
        )

    monkeypatch.setattr(
        route_module.service, "get_mode", _fake
    )
    resp = client.get(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "HALT"
    assert body["expires_at"] is None
    assert body["note"] == "halt for deploy"


def test_get_returns_502_on_service_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom() -> service.ApprovalModeRow:
        raise service.ApprovalModeError("db down")

    monkeypatch.setattr(route_module.service, "get_mode", _boom)
    resp = client.get(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 502
    assert "db down" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# PUT — validation
# ---------------------------------------------------------------------------


def test_put_rejects_unknown_mode(client: TestClient) -> None:
    resp = client.put(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"mode": "NOPE"},
    )
    assert resp.status_code == 422


def test_put_rejects_auto_approve_without_ttl(
    client: TestClient,
) -> None:
    resp = client.put(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"mode": "AUTO_APPROVE"},
    )
    assert resp.status_code == 422
    assert "ttl_seconds" in resp.json()["detail"].lower()


def test_put_rejects_ask_with_ttl(client: TestClient) -> None:
    resp = client.put(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"mode": "ASK", "ttl_seconds": 3600},
    )
    assert resp.status_code == 422


def test_put_rejects_halt_with_ttl(client: TestClient) -> None:
    resp = client.put(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"mode": "HALT", "ttl_seconds": 60},
    )
    assert resp.status_code == 422


def test_put_rejects_ttl_below_minimum(client: TestClient) -> None:
    resp = client.put(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"mode": "AUTO_APPROVE", "ttl_seconds": 1},
    )
    assert resp.status_code == 422


def test_put_rejects_ttl_above_maximum(client: TestClient) -> None:
    resp = client.put(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"mode": "AUTO_APPROVE", "ttl_seconds": 100_000},
    )
    assert resp.status_code == 422


def test_put_rejects_missing_mode(client: TestClient) -> None:
    """Pydantic enforces ``mode`` presence; we get a 422 before service."""
    resp = client.put(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"ttl_seconds": 3600},
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# PUT — happy path
# ---------------------------------------------------------------------------


def test_put_happy_path_returns_updated_row(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}

    async def _fake(**kwargs: Any) -> service.ApprovalModeRow:
        captured.update(kwargs)
        return service.ApprovalModeRow(
            mode=kwargs["mode"],
            expires_at="2026-05-19T13:00:00+00:00",
            set_by=kwargs["changed_by"],
            set_at="2026-05-19T12:00:00+00:00",
            note=kwargs.get("note"),
        )

    monkeypatch.setattr(route_module.service, "set_mode", _fake)

    resp = client.put(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json=_valid_put_body(),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "AUTO_APPROVE"
    assert body["set_by"] == "dashboard"
    assert captured["mode"] == "AUTO_APPROVE"
    assert captured["ttl_seconds"] == 3600
    assert captured["changed_by"] == "dashboard"
    assert captured["note"] == "batch run"


def test_put_idempotent_repeat_post_is_safe(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two identical PUTs both succeed; the spec doesn't 409 on no-op
    transitions because the audit row is still a useful signal."""
    calls: list[Any] = []

    async def _fake(**kwargs: Any) -> service.ApprovalModeRow:
        calls.append(kwargs)
        return service.ApprovalModeRow(
            mode=kwargs["mode"],
            expires_at=None,
            set_by=kwargs["changed_by"],
            set_at="2026-05-19T12:00:00+00:00",
            note=None,
        )

    monkeypatch.setattr(route_module.service, "set_mode", _fake)

    for _ in range(2):
        resp = client.put(
            "/work/hermes/approval-mode",
            headers={"Authorization": f"Bearer {TOKEN}"},
            json={"mode": "HALT"},
        )
        assert resp.status_code == 200
    assert len(calls) == 2


def test_put_custom_changed_by(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}

    async def _fake(**kwargs: Any) -> service.ApprovalModeRow:
        captured.update(kwargs)
        return service.ApprovalModeRow(
            mode=kwargs["mode"],
            expires_at=None,
            set_by=kwargs["changed_by"],
            set_at="x",
            note=None,
        )

    monkeypatch.setattr(route_module.service, "set_mode", _fake)
    resp = client.put(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"mode": "HALT", "changed_by": "ops-bot"},
    )
    assert resp.status_code == 200
    assert captured["changed_by"] == "ops-bot"


def test_put_returns_422_on_service_invalid_mode(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom(**_kwargs: Any) -> service.ApprovalModeRow:
        raise service.InvalidModeError("invalid mode from service")

    monkeypatch.setattr(route_module.service, "set_mode", _boom)
    resp = client.put(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"mode": "HALT"},
    )
    assert resp.status_code == 422
    assert "invalid mode from service" in resp.json()["detail"]


def test_put_returns_502_on_service_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom(**_kwargs: Any) -> service.ApprovalModeRow:
        raise service.ApprovalModeError("db unreachable")

    monkeypatch.setattr(route_module.service, "set_mode", _boom)
    resp = client.put(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"mode": "HALT"},
    )
    assert resp.status_code == 502
    assert "db unreachable" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# GET /audit
# ---------------------------------------------------------------------------


def test_audit_returns_entries(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _fake(limit: int) -> list[service.ApprovalModeAuditRow]:
        return [
            service.ApprovalModeAuditRow(
                id="a",
                from_mode="ASK",
                to_mode="HALT",
                ttl_seconds=None,
                changed_at="2026-05-19T10:00:00+00:00",
                changed_by="dashboard",
                note="halted",
            ),
        ]

    monkeypatch.setattr(
        route_module.service, "get_audit_rows", _fake
    )
    resp = client.get(
        "/work/hermes/approval-mode/audit",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["entries"]) == 1
    assert body["entries"][0]["to_mode"] == "HALT"
    assert body["entries"][0]["from_mode"] == "ASK"


def test_audit_rejects_limit_below_one(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """FastAPI's ``ge=1`` validates this at the query layer."""
    resp = client.get(
        "/work/hermes/approval-mode/audit?limit=0",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 422


def test_audit_rejects_limit_above_max(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    resp = client.get(
        "/work/hermes/approval-mode/audit?limit=99999",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 422


def test_audit_returns_502_on_service_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom(limit: int) -> list[service.ApprovalModeAuditRow]:
        raise service.ApprovalModeError("audit db down")

    monkeypatch.setattr(
        route_module.service, "get_audit_rows", _boom
    )
    resp = client.get(
        "/work/hermes/approval-mode/audit",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 502
    assert "audit db down" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Token format edges
# ---------------------------------------------------------------------------


def test_get_extra_whitespace_in_token_still_accepted(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _fake() -> service.ApprovalModeRow:
        return service.ApprovalModeRow(
            mode="ASK",
            expires_at=None,
            set_by=None,
            set_at="x",
            note=None,
        )

    monkeypatch.setattr(route_module.service, "get_mode", _fake)
    resp = client.get(
        "/work/hermes/approval-mode",
        headers={"Authorization": f"Bearer {TOKEN} "},
    )
    assert resp.status_code == 200
