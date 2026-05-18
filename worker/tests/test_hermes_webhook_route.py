"""Tests for the POST /work/hermes/webhook route.

Agent D wires :mod:`src.routes.hermes_webhook` into ``src.main`` as part
of a separate change; until then we build a minimal FastAPI app inline so
the route can be exercised end-to-end through ``TestClient``.

We assert the three documented response shapes:

* 401 — bad / missing / unset bearer.
* 204 — valid bearer + well-formed payload.
* 200 — valid bearer + malformed body OR a handler exception.

The Supabase client is patched so the service's downstream side effects
are inert.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# We deliberately do NOT register a fake ``pywebpush`` module here. The
# only path through this test that touches push delivery is the
# end-to-end case, which uses ``session_ended`` (no spend fan-out), so
# the lazy pywebpush import never executes. Avoiding ``sys.modules``
# shims keeps us out of ``test_push_delivery.py``'s way.

from src.routes import hermes_webhook as route_module  # noqa: E402
from src.services import hermes_webhook as service  # noqa: E402


TOKEN = "hermes-test-token"


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DASHBOARD_WEBHOOK_TOKEN", TOKEN)


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Replace ``handle_event`` with a recorder so we can inspect inputs."""
    received: list[dict[str, Any]] = []

    async def _recorder(event: dict[str, Any]) -> None:
        received.append(event)

    # NOTE: The route imports the service *module*, so we patch the
    # attribute that the route looks up — ``hermes_webhook_service.handle_event``.
    monkeypatch.setattr(
        route_module.hermes_webhook_service, "handle_event", _recorder
    )
    return received


@pytest.fixture
def app() -> FastAPI:
    app = FastAPI()
    app.include_router(route_module.router)
    return app


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


# ---------------------------------------------------------------------------
# Auth gate
# ---------------------------------------------------------------------------


def test_missing_authorization_returns_401(
    client: TestClient, calls: list[dict[str, Any]]
) -> None:
    resp = client.post("/work/hermes/webhook", json={"kind": "session_started"})
    assert resp.status_code == 401
    assert resp.headers.get("www-authenticate") == "Bearer"
    assert calls == []  # handler not called


def test_wrong_authorization_scheme_returns_401(
    client: TestClient, calls: list[dict[str, Any]]
) -> None:
    resp = client.post(
        "/work/hermes/webhook",
        headers={"Authorization": f"Basic {TOKEN}"},
        json={"kind": "session_started"},
    )
    assert resp.status_code == 401
    assert calls == []


def test_invalid_token_returns_401(
    client: TestClient, calls: list[dict[str, Any]]
) -> None:
    resp = client.post(
        "/work/hermes/webhook",
        headers={"Authorization": "Bearer wrong-token"},
        json={"kind": "session_started"},
    )
    assert resp.status_code == 401
    assert calls == []


def test_unset_token_env_rejects_all_requests(
    client: TestClient,
    calls: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fail closed: if DASHBOARD_WEBHOOK_TOKEN is unset, every request 401s."""
    monkeypatch.delenv("DASHBOARD_WEBHOOK_TOKEN", raising=False)
    resp = client.post(
        "/work/hermes/webhook",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"kind": "session_started"},
    )
    assert resp.status_code == 401
    assert calls == []


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_valid_token_and_payload_returns_204(
    client: TestClient, calls: list[dict[str, Any]]
) -> None:
    body = {"kind": "tool_completed", "tool_name": "Bash", "risk_class": "spend"}
    resp = client.post(
        "/work/hermes/webhook",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json=body,
    )
    assert resp.status_code == 204
    assert resp.content == b""
    assert calls == [body]


def test_valid_token_with_empty_body_object(
    client: TestClient, calls: list[dict[str, Any]]
) -> None:
    """The service drops events without ``kind`` but the route still 204s."""
    resp = client.post(
        "/work/hermes/webhook",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={},
    )
    assert resp.status_code == 204
    # handler IS called (route doesn't enforce a schema); service filters.
    assert calls == [{}]


# ---------------------------------------------------------------------------
# Malformed body — 200 + log
# ---------------------------------------------------------------------------


def test_malformed_json_body_returns_200(
    client: TestClient, calls: list[dict[str, Any]]
) -> None:
    """Non-JSON body → 200 (not 4xx/5xx) so Ekko's hook caller doesn't escalate."""
    resp = client.post(
        "/work/hermes/webhook",
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "text/plain"},
        content=b"not-json-at-all",
    )
    assert resp.status_code == 200
    assert calls == []  # handler never invoked


def test_handler_exception_returns_200(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If handle_event somehow raises, the route still returns 200 (not 5xx)."""

    async def _boom(_event: dict[str, Any]) -> None:
        raise RuntimeError("downstream blew up")

    monkeypatch.setattr(
        route_module.hermes_webhook_service, "handle_event", _boom
    )

    resp = client.post(
        "/work/hermes/webhook",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"kind": "session_started"},
    )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# End-to-end with the real service — Supabase fan-out happens through
# the service patches, but we exercise the wiring once to lock in that
# ``handle_event`` is the symbol the route calls.
# ---------------------------------------------------------------------------


def test_end_to_end_with_real_service_writes_pipeline_event(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Real service → fake Supabase → 204 + an insert observed."""

    inserts: list[tuple[str, dict[str, Any]]] = []

    class _T:
        def __init__(self, name: str) -> None:
            self.name = name

        def select(self, _cols: str) -> "_T":
            return self

        def insert(self, row: dict[str, Any]) -> "_T":
            inserts.append((self.name, row))
            return self

        def execute(self) -> Any:
            return MagicMock(data=[])

    class _SB:
        def table(self, name: str) -> _T:
            return _T(name)

    monkeypatch.setattr(service, "get_supabase_admin", lambda: _SB())

    resp = client.post(
        "/work/hermes/webhook",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"kind": "session_ended", "session_id": "s-42"},
    )
    assert resp.status_code == 204
    pe = [r for n, r in inserts if n == "pipeline_events"]
    assert len(pe) == 1
    assert pe[0]["kind"] == "session_ended"
    assert pe[0]["payload"]["event"]["session_id"] == "s-42"
