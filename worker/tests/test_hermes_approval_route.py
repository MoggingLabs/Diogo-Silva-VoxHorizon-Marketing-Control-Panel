"""Tests for the /work/hermes/approval routes (HI-14).

Coverage targets:

* Bearer auth: valid / missing / wrong scheme / wrong token / unset env
* POST body validation (Pydantic surfaces 422)
* POST happy path returns the service's decision
* POST surfaces 503 when the concurrency cap is full
* POST surfaces 502 on :class:`ApprovalError`
* GET 200 / 404 / 502 / 401
* Cancel 200 (cancelled / not cancelled) / 502 / 401

We mount the router on a bare FastAPI app — main.py wiring is the
orchestrator's responsibility — so the tests stand alone.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.routes import hermes_approval as route_module
from src.services import hermes_approval as service


TOKEN = "approval-test-token"


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VOXHORIZON_APPROVAL_TOKEN", TOKEN)


@pytest.fixture(autouse=True)
def _reset_slots() -> None:
    service._reset_slots()
    yield
    service._reset_slots()


@pytest.fixture
def app() -> FastAPI:
    a = FastAPI()
    a.include_router(route_module.router)
    return a


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


def _valid_body() -> dict[str, Any]:
    return {
        "approval_id": "ap-1",
        "ekko_session_id": "sess-1",
        "ekko_tool_call_id": "tc-1",
        "tool_name": "BashTool",
        "tool_args": {"command": "ls"},
        "risk_class": "fs",
        "context": {"why": "test"},
        "timeout_s": 5,
    }


# ---------------------------------------------------------------------------
# Auth gate
# ---------------------------------------------------------------------------


def test_post_missing_authorization_returns_401(client: TestClient) -> None:
    resp = client.post("/work/hermes/approval", json=_valid_body())
    assert resp.status_code == 401
    assert resp.headers.get("www-authenticate") == "Bearer"


def test_post_wrong_scheme_returns_401(client: TestClient) -> None:
    resp = client.post(
        "/work/hermes/approval",
        headers={"Authorization": f"Basic {TOKEN}"},
        json=_valid_body(),
    )
    assert resp.status_code == 401


def test_post_wrong_token_returns_401(client: TestClient) -> None:
    resp = client.post(
        "/work/hermes/approval",
        headers={"Authorization": "Bearer nope"},
        json=_valid_body(),
    )
    assert resp.status_code == 401


def test_post_unset_token_env_rejects_all_requests(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("VOXHORIZON_APPROVAL_TOKEN", raising=False)
    resp = client.post(
        "/work/hermes/approval",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json=_valid_body(),
    )
    assert resp.status_code == 401


def test_get_missing_authorization_returns_401(
    client: TestClient,
) -> None:
    resp = client.get("/work/hermes/approval/ap-1")
    assert resp.status_code == 401


def test_get_wrong_token_returns_401(client: TestClient) -> None:
    resp = client.get(
        "/work/hermes/approval/ap-1",
        headers={"Authorization": "Bearer wrong"},
    )
    assert resp.status_code == 401


def test_cancel_missing_authorization_returns_401(
    client: TestClient,
) -> None:
    resp = client.post("/work/hermes/approval/ap-1/cancel")
    assert resp.status_code == 401


def test_cancel_wrong_token_returns_401(client: TestClient) -> None:
    resp = client.post(
        "/work/hermes/approval/ap-1/cancel",
        headers={"Authorization": "Bearer wrong"},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Pydantic validation
# ---------------------------------------------------------------------------


def test_post_rejects_missing_required_fields(client: TestClient) -> None:
    body = _valid_body()
    body.pop("approval_id")
    resp = client.post(
        "/work/hermes/approval",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json=body,
    )
    assert resp.status_code == 422


def test_post_rejects_empty_approval_id(client: TestClient) -> None:
    body = _valid_body()
    body["approval_id"] = ""
    resp = client.post(
        "/work/hermes/approval",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json=body,
    )
    assert resp.status_code == 422


def test_post_rejects_non_positive_timeout(client: TestClient) -> None:
    body = _valid_body()
    body["timeout_s"] = 0
    resp = client.post(
        "/work/hermes/approval",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json=body,
    )
    assert resp.status_code == 422


def test_post_accepts_missing_optional_fields(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``risk_class`` + ``context`` + ``timeout_s`` are optional."""

    captured: dict[str, Any] = {}

    async def _fake(**kwargs: Any) -> service.ApprovalDecision:
        captured.update(kwargs)
        return service.ApprovalDecision(decision="approved", notes=None)

    monkeypatch.setattr(route_module.service, "request_approval", _fake)

    body = {
        "approval_id": "ap-1",
        "ekko_session_id": "sess-1",
        "ekko_tool_call_id": "tc-1",
        "tool_name": "BashTool",
        "tool_args": {},
    }
    resp = client.post(
        "/work/hermes/approval",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json=body,
    )
    assert resp.status_code == 200
    # The default timeout came from the service module's constant.
    assert captured["timeout_s"] == service.DEFAULT_TIMEOUT_S
    assert captured["risk_class"] is None
    assert captured["context"] is None


# ---------------------------------------------------------------------------
# POST happy path + error mapping
# ---------------------------------------------------------------------------


def test_post_returns_service_decision(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _fake(**_kwargs: Any) -> service.ApprovalDecision:
        return service.ApprovalDecision(
            decision="approved_with_caveat",
            notes="just this once",
        )

    monkeypatch.setattr(route_module.service, "request_approval", _fake)

    resp = client.post(
        "/work/hermes/approval",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json=_valid_body(),
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "decision": "approved_with_caveat",
        "notes": "just this once",
    }


def test_post_returns_503_when_cap_full(
    client: TestClient,
) -> None:
    """Fill all MAX_CONCURRENT slots → the next POST gets 503."""
    # Force every slot taken
    import asyncio

    async def _fill() -> list[Any]:
        guards = []
        for _ in range(service.MAX_CONCURRENT):
            g = await service.acquire_slot()
            assert g is not None
            guards.append(g)
        return guards

    loop = asyncio.new_event_loop()
    try:
        guards = loop.run_until_complete(_fill())
    finally:
        loop.close()

    try:
        resp = client.post(
            "/work/hermes/approval",
            headers={"Authorization": f"Bearer {TOKEN}"},
            json=_valid_body(),
        )
        assert resp.status_code == 503
        assert "capacity" in resp.json()["detail"].lower()
    finally:
        # Drain the slot counter so subsequent tests start clean.
        service._reset_slots()
        del guards


def test_post_returns_502_on_approval_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom(**_kwargs: Any) -> service.ApprovalDecision:
        raise service.ApprovalError("supabase exploded")

    monkeypatch.setattr(route_module.service, "request_approval", _boom)

    resp = client.post(
        "/work/hermes/approval",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json=_valid_body(),
    )
    assert resp.status_code == 502
    assert "supabase exploded" in resp.json()["detail"]


def test_post_releases_slot_on_approval_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 502 mid-poll must NOT leak a concurrency slot."""

    async def _boom(**_kwargs: Any) -> service.ApprovalDecision:
        raise service.ApprovalError("supabase exploded")

    monkeypatch.setattr(route_module.service, "request_approval", _boom)

    # Burn 5 unsuccessful approvals; the slot count must always recover.
    for _ in range(5):
        resp = client.post(
            "/work/hermes/approval",
            headers={"Authorization": f"Bearer {TOKEN}"},
            json=_valid_body(),
        )
        assert resp.status_code == 502
    assert service._current_slot_count() == 0


# ---------------------------------------------------------------------------
# GET route
# ---------------------------------------------------------------------------


def test_get_returns_row(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _fake(approval_id: str) -> dict[str, Any] | None:
        return {"id": approval_id, "status": "decided"}

    monkeypatch.setattr(route_module.service, "get_approval", _fake)

    resp = client.get(
        "/work/hermes/approval/ap-1",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 200
    assert resp.json()["id"] == "ap-1"
    assert resp.json()["status"] == "decided"


def test_get_returns_404_when_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _fake(_approval_id: str) -> dict[str, Any] | None:
        return None

    monkeypatch.setattr(route_module.service, "get_approval", _fake)

    resp = client.get(
        "/work/hermes/approval/ap-1",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 404


def test_get_returns_502_on_approval_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom(_approval_id: str) -> dict[str, Any] | None:
        raise service.ApprovalError("db unreachable")

    monkeypatch.setattr(route_module.service, "get_approval", _boom)

    resp = client.get(
        "/work/hermes/approval/ap-1",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 502
    assert "db unreachable" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Cancel route
# ---------------------------------------------------------------------------


def test_cancel_returns_true_when_pending(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _fake(_approval_id: str) -> bool:
        return True

    monkeypatch.setattr(route_module.service, "cancel_approval", _fake)

    resp = client.post(
        "/work/hermes/approval/ap-1/cancel",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"cancelled": True}


def test_cancel_returns_false_when_already_decided(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Idempotent — already-decided cancels still return 200."""

    async def _fake(_approval_id: str) -> bool:
        return False

    monkeypatch.setattr(route_module.service, "cancel_approval", _fake)

    resp = client.post(
        "/work/hermes/approval/ap-1/cancel",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"cancelled": False}


def test_cancel_returns_502_on_approval_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom(_approval_id: str) -> bool:
        raise service.ApprovalError("db broken")

    monkeypatch.setattr(route_module.service, "cancel_approval", _boom)

    resp = client.post(
        "/work/hermes/approval/ap-1/cancel",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 502
    assert "db broken" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Token format edges
# ---------------------------------------------------------------------------


def test_post_extra_whitespace_in_token_still_accepted(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The route's strip() means a trailing space on the bearer is fine."""

    async def _fake(**_kwargs: Any) -> service.ApprovalDecision:
        return service.ApprovalDecision(decision="approved", notes=None)

    monkeypatch.setattr(route_module.service, "request_approval", _fake)

    resp = client.post(
        "/work/hermes/approval",
        headers={"Authorization": f"Bearer {TOKEN} "},
        json=_valid_body(),
    )
    assert resp.status_code == 200
