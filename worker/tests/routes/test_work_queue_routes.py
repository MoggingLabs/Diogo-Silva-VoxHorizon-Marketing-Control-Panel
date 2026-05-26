"""Route tests for ``/work/queue/*`` (silent-failure PR-1).

Exercises every route via the shared FakeSupabase double from
``tests/conftest.py``. The double is FK / CHECK / trigger blind (that's
the integration tier's job), but it captures inserts + updates + rpc
calls precisely so the bearer-auth + body validation + token-rotation
contract + idempotency-dedup behaviours are pinned at the API boundary.

The route tests do NOT re-validate the DB invariants (those land in
``tests/queue/test_state_machine.py``). They validate the HTTP shape:
  * auth required on every route;
  * 201 on consumer create + 200 on a successful claim + 204 on every PATCH;
  * 409 on a token-rotated heartbeat / complete / fail;
  * 422 on a malformed body;
  * idempotency-key dedup returns the existing row, never re-inserts.
"""

from __future__ import annotations

import json
from typing import Any
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers: extend FakeSupabase with a default rpc/insert path for work_item.
# ---------------------------------------------------------------------------


def _seed_unused(_fake_sb) -> None:
    """No-op seed: most route tests start with an empty queue."""
    pass


# ---------------------------------------------------------------------------
# /work/queue/claim
# ---------------------------------------------------------------------------


def test_claim_returns_row_when_due(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Happy path: the RPC returns a row -> the route returns 200 with body."""
    fake_supabase.rpc_return = [
        {
            "id": "wi-1",
            "kind": "operator_dispatch",
            "status": "claimed",
            "claim_token": "tok-1",
            "claimed_by": "consumer-A",
        }
    ]
    import src.routes.work_queue as wq_route

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)

    resp = client.post(
        "/work/queue/claim",
        json={"kind": "operator_dispatch", "consumer_id": "consumer-A"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == "wi-1"
    assert body["claim_token"] == "tok-1"
    assert fake_supabase.rpc_calls == [
        ("claim_work_item", {"p_kind": "operator_dispatch", "p_consumer": "consumer-A"})
    ]


def test_claim_returns_204_when_nothing_due(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_supabase.rpc_return = None
    import src.routes.work_queue as wq_route

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)

    resp = client.post(
        "/work/queue/claim",
        json={"kind": "operator_dispatch", "consumer_id": "consumer-A"},
        headers=auth_headers,
    )
    assert resp.status_code == 204


def test_claim_requires_auth(client: TestClient) -> None:
    resp = client.post(
        "/work/queue/claim",
        json={"kind": "operator_dispatch", "consumer_id": "consumer-A"},
    )
    assert resp.status_code == 401


def test_claim_rejects_bad_kind(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unknown ``kind`` value is rejected at the API boundary."""
    import src.routes.work_queue as wq_route

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)
    resp = client.post(
        "/work/queue/claim",
        json={"kind": "bogus_kind", "consumer_id": "c-A"},
        headers=auth_headers,
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# /work/queue/{id}/heartbeat
# ---------------------------------------------------------------------------


def test_heartbeat_204_on_live_claim(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A heartbeat with a valid token returns 204."""
    import src.routes.work_queue as wq_route

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)
    monkeypatch.setattr(wq_route.work_queue, "heartbeat_work_item", lambda sb, **kw: True)

    resp = client.patch(
        "/work/queue/wi-1/heartbeat",
        json={"claim_token": "tok-good"},
        headers=auth_headers,
    )
    assert resp.status_code == 204


def test_heartbeat_409_on_rotated_token(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A heartbeat whose token was rotated returns 409 token_rotated."""
    import src.routes.work_queue as wq_route

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)
    monkeypatch.setattr(wq_route.work_queue, "heartbeat_work_item", lambda sb, **kw: False)

    resp = client.patch(
        "/work/queue/wi-1/heartbeat",
        json={"claim_token": "tok-stale"},
        headers=auth_headers,
    )
    assert resp.status_code == 409


def test_heartbeat_requires_auth(client: TestClient) -> None:
    resp = client.patch(
        "/work/queue/wi-1/heartbeat", json={"claim_token": "any"}
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# /work/queue/{id}/complete
# ---------------------------------------------------------------------------


def test_complete_204_with_result(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import src.routes.work_queue as wq_route

    captured: dict[str, Any] = {}

    def fake_complete(sb, **kw):
        captured.update(kw)
        return True

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)
    monkeypatch.setattr(wq_route.work_queue, "complete_work_item", fake_complete)

    resp = client.patch(
        "/work/queue/wi-7/complete",
        json={"claim_token": "tok-good", "result": {"output": "ok"}},
        headers=auth_headers,
    )
    assert resp.status_code == 204
    assert captured["work_item_id"] == "wi-7"
    assert captured["claim_token"] == "tok-good"
    assert captured["result"] == {"output": "ok"}


def test_complete_409_on_rotated_token(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import src.routes.work_queue as wq_route

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)
    monkeypatch.setattr(wq_route.work_queue, "complete_work_item", lambda sb, **kw: False)

    resp = client.patch(
        "/work/queue/wi-7/complete",
        json={"claim_token": "stale", "result": None},
        headers=auth_headers,
    )
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# /work/queue/{id}/fail
# ---------------------------------------------------------------------------


def test_fail_204_with_error_kind(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import src.routes.work_queue as wq_route

    captured: dict[str, Any] = {}

    def fake_fail(sb, **kw):
        captured.update(kw)
        return True

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)
    monkeypatch.setattr(wq_route.work_queue, "fail_work_item", fake_fail)

    resp = client.patch(
        "/work/queue/wi-9/fail",
        json={
            "claim_token": "tok-good",
            "error_kind": "auth_expired",
            "error_detail": {"http": 401},
            "retryable": False,
        },
        headers=auth_headers,
    )
    assert resp.status_code == 204
    assert captured["error_kind"] == "auth_expired"
    assert captured["retryable"] is False
    assert captured["error_detail"] == {"http": 401}


def test_fail_422_when_error_kind_missing(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """error_kind is mandatory at the API boundary (mirror of the CHECK)."""
    import src.routes.work_queue as wq_route

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)
    resp = client.patch(
        "/work/queue/wi-9/fail",
        json={"claim_token": "any"},
        headers=auth_headers,
    )
    assert resp.status_code == 422


def test_fail_409_on_rotated_token(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import src.routes.work_queue as wq_route

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)
    monkeypatch.setattr(wq_route.work_queue, "fail_work_item", lambda sb, **kw: False)

    resp = client.patch(
        "/work/queue/wi-9/fail",
        json={"claim_token": "stale", "error_kind": "auth_expired"},
        headers=auth_headers,
    )
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# /work/queue/{id}/cancel
# ---------------------------------------------------------------------------


def test_cancel_force_cancel_without_token_is_204(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Admin path: no token -> force cancel always 204 (the trigger covers it)."""
    import src.routes.work_queue as wq_route

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)
    # No-row return: simulates the admin path force-cancelling a row not yet
    # in the table; the route still returns 204.
    monkeypatch.setattr(wq_route.work_queue, "cancel_work_item", lambda sb, **kw: False)

    resp = client.patch(
        "/work/queue/wi-c/cancel",
        json={"reason": "operator"},
        headers=auth_headers,
    )
    assert resp.status_code == 204


def test_cancel_token_scoped_409_on_rotated_token(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Consumer path: token-scoped cancel raced by the watchdog -> 409."""
    import src.routes.work_queue as wq_route

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)
    monkeypatch.setattr(wq_route.work_queue, "cancel_work_item", lambda sb, **kw: False)

    resp = client.patch(
        "/work/queue/wi-c/cancel",
        json={"reason": "consumer_shutdown", "claim_token": "stale"},
        headers=auth_headers,
    )
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# /work/queue/consumers (POST) + /work/queue/consumers/{id} (PATCH)
# ---------------------------------------------------------------------------


def test_create_consumer_201(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import src.routes.work_queue as wq_route

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)
    resp = client.post(
        "/work/queue/consumers",
        json={
            "id": "daemon-1",
            "kind": "operator_dispatch",
            "status": "starting",
            "startup_check": {"auth": "ok"},
            "image_tag": "v1.0.0",
            "hostname": "operator-1",
        },
        headers=auth_headers,
    )
    assert resp.status_code == 201
    assert any(
        t == "work_item_consumers" and r.get("id") == "daemon-1"
        for t, r in fake_supabase.inserts
    )


def test_patch_consumer_204_heartbeat_only(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """PATCH with no fields = a pure heartbeat (bumps last_seen_at)."""
    import src.routes.work_queue as wq_route

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)
    resp = client.patch(
        "/work/queue/consumers/daemon-1", json={}, headers=auth_headers
    )
    assert resp.status_code == 204


def test_patch_consumer_204_status_transition(
    client: TestClient,
    fake_supabase,
    auth_headers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import src.routes.work_queue as wq_route

    monkeypatch.setattr(wq_route, "get_supabase_admin", lambda: fake_supabase)
    resp = client.patch(
        "/work/queue/consumers/daemon-1",
        json={"status": "live"},
        headers=auth_headers,
    )
    assert resp.status_code == 204
    assert any(
        t == "work_item_consumers" and r.get("status") == "live"
        for t, r in fake_supabase.updates
    )


# ---------------------------------------------------------------------------
# Facade: enqueue_work_item dedup (smoke test that the route boundary
# does not silently swallow a duplicate).
# ---------------------------------------------------------------------------


def test_facade_enqueue_dedups_on_idempotency_key(fake_supabase) -> None:
    """Two enqueues with the same key return the same row -- no double insert."""
    from src.services.work_queue import enqueue_work_item

    fake_supabase.set_single(
        "work_item",
        {"id": "wi-existing", "kind": "operator_dispatch", "status": "queued"},
    )
    out = enqueue_work_item(
        fake_supabase,
        kind="operator_dispatch",
        payload={"instruction": "draft"},
        idempotency_key="op-disp:p-1:configuration:kickoff",
        created_by="test",
        pipeline_id="p-1",
    )
    assert out["id"] == "wi-existing"
    # No insert was attempted -- a dedup short-circuits before write.
    assert not any(t == "work_item" for t, _ in fake_supabase.inserts)


def test_facade_enqueue_inserts_when_no_existing(fake_supabase) -> None:
    from src.services.work_queue import enqueue_work_item

    fake_supabase.set_single("work_item", None)
    out = enqueue_work_item(
        fake_supabase,
        kind="operator_dispatch",
        payload={"instruction": "draft"},
        idempotency_key="op-disp:p-2:configuration:kickoff",
        created_by="test",
        pipeline_id="p-2",
    )
    assert out.get("id")  # FakeSupabase mints an id
    # Exactly one insert was made.
    inserts = [r for t, r in fake_supabase.inserts if t == "work_item"]
    assert len(inserts) == 1
    assert inserts[0]["idempotency_key"] == "op-disp:p-2:configuration:kickoff"
    assert inserts[0]["pipeline_id"] == "p-2"
    assert inserts[0]["created_by"] == "test"
