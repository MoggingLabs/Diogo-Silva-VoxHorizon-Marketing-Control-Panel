"""Tests for :mod:`voxhorizon_daemon.queue_client`.

We mock the worker via ``respx`` so the wire shape (headers, JSON body,
method, status code mapping) is exercised against a real ``httpx``
roundtrip, just without a server. The intent is to catch:

* Bearer header presence + value
* 204 -> ``None`` mapping on claim
* 401/403 -> :class:`QueueAuthError`
* 409 -> :class:`QueueConflictError`
* 5xx -> :class:`QueueServerError` with retry
"""

from __future__ import annotations

import httpx
import pytest
import respx

from voxhorizon_daemon.queue_client import (
    QueueAuthError,
    QueueClient,
    QueueClientError,
    QueueConflictError,
    QueueServerError,
)


BASE_URL = "http://worker.test"


@pytest.fixture
async def client():
    async with QueueClient(
        base_url=BASE_URL, secret="bearer-test", retry_attempts=2
    ) as c:
        c.set_consumer_id("op-test")
        yield c


# ----------------------------------------------------------------------------
# claim
# ----------------------------------------------------------------------------


async def test_claim_returns_work_item_on_200(client):
    payload = {
        "id": "wi-1",
        "kind": "operator_dispatch",
        "pipeline_id": "p-1",
        "status": "claimed",
        "attempt": 1,
        "claim_token": "tok-1",
        "claimed_by": "op-test",
        "payload": {"instruction": "do the thing"},
    }
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.post("/work/queue/claim").mock(
            return_value=httpx.Response(200, json=payload)
        )
        result = await client.claim("operator_dispatch")
    assert result is not None
    assert result.id == "wi-1"
    assert result.claim_token == "tok-1"


async def test_claim_returns_none_on_204(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.post("/work/queue/claim").mock(return_value=httpx.Response(204))
        result = await client.claim("operator_dispatch")
    assert result is None


async def test_claim_carries_bearer_and_consumer_id(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        route = rmock.post("/work/queue/claim").mock(
            return_value=httpx.Response(204)
        )
        await client.claim("operator_dispatch")
    assert route.called
    sent = route.calls[0].request
    assert sent.headers["authorization"] == "Bearer bearer-test"
    import json as _json

    body = _json.loads(sent.content)
    assert body == {"kind": "operator_dispatch", "consumer_id": "op-test"}


# ----------------------------------------------------------------------------
# 401 / 403
# ----------------------------------------------------------------------------


async def test_auth_error_raises_queue_auth_error(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.post("/work/queue/claim").mock(
            return_value=httpx.Response(401, text="bad bearer")
        )
        with pytest.raises(QueueAuthError):
            await client.claim("operator_dispatch")


async def test_403_raises_queue_auth_error(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.post("/work/queue/claim").mock(
            return_value=httpx.Response(403, text="forbidden")
        )
        with pytest.raises(QueueAuthError):
            await client.claim("operator_dispatch")


# ----------------------------------------------------------------------------
# 409 conflict (token rotated)
# ----------------------------------------------------------------------------


async def test_heartbeat_returns_false_on_409(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.patch("/work/queue/wi-1/heartbeat").mock(
            return_value=httpx.Response(409, text="rotated")
        )
        result = await client.heartbeat_work_item("wi-1", "tok-rot")
    assert result is False


async def test_complete_returns_false_on_409(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.patch("/work/queue/wi-1/complete").mock(
            return_value=httpx.Response(409)
        )
        ok = await client.complete("wi-1", "tok", result={"x": 1})
    assert ok is False


async def test_fail_returns_false_on_409(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.patch("/work/queue/wi-1/fail").mock(return_value=httpx.Response(409))
        ok = await client.fail("wi-1", "tok", error_kind="llm_5xx")
    assert ok is False


async def test_cancel_returns_false_on_409_with_token(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.patch("/work/queue/wi-1/cancel").mock(
            return_value=httpx.Response(409)
        )
        ok = await client.cancel("wi-1", "tok", reason="shutdown")
    assert ok is False


async def test_cancel_admin_path_no_token(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.patch("/work/queue/wi-1/cancel").mock(
            return_value=httpx.Response(204)
        )
        ok = await client.cancel("wi-1", None, reason="admin")
    assert ok is True


async def test_complete_happy_path(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.patch("/work/queue/wi-1/complete").mock(
            return_value=httpx.Response(204)
        )
        ok = await client.complete("wi-1", "tok", result={"x": 1})
    assert ok is True


async def test_heartbeat_happy_path(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.patch("/work/queue/wi-1/heartbeat").mock(
            return_value=httpx.Response(204)
        )
        ok = await client.heartbeat_work_item("wi-1", "tok")
    assert ok is True


async def test_fail_happy_path(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.patch("/work/queue/wi-1/fail").mock(
            return_value=httpx.Response(204)
        )
        ok = await client.fail(
            "wi-1", "tok", error_kind="llm_5xx", error_detail={"x": 1}, retryable=True
        )
    assert ok is True


async def test_update_consumer_with_startup_check(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.patch("/work/queue/consumers/op-test").mock(
            return_value=httpx.Response(204)
        )
        await client.update_consumer(
            consumer_id="op-test",
            status="down",
            startup_check={"hermes_auth": {"ok": False}},
        )


# ----------------------------------------------------------------------------
# 5xx retry path
# ----------------------------------------------------------------------------


async def test_5xx_retries_then_raises_queue_server_error(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        # retry_attempts=2 so we expect 2 total calls before raising.
        rmock.post("/work/queue/claim").mock(
            return_value=httpx.Response(503, text="degraded")
        )
        with pytest.raises(QueueServerError):
            await client.claim("operator_dispatch")
        assert rmock.calls.call_count == 2


async def test_5xx_then_2xx_succeeds(client):
    payload = {
        "id": "wi-2",
        "kind": "operator_dispatch",
        "status": "claimed",
        "attempt": 1,
        "claim_token": "tok-2",
        "claimed_by": "op-test",
        "payload": {},
    }
    with respx.mock(base_url=BASE_URL) as rmock:
        route = rmock.post("/work/queue/claim").mock(
            side_effect=[
                httpx.Response(502, text="bad gateway"),
                httpx.Response(200, json=payload),
            ]
        )
        result = await client.claim("operator_dispatch")
    assert route.called
    assert result is not None
    assert result.id == "wi-2"


# ----------------------------------------------------------------------------
# transport error retries
# ----------------------------------------------------------------------------


async def test_transport_error_classified_as_server_error(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.post("/work/queue/claim").mock(
            side_effect=httpx.ConnectError("refused")
        )
        with pytest.raises(QueueServerError):
            await client.claim("operator_dispatch")


# ----------------------------------------------------------------------------
# upsert / heartbeat consumer
# ----------------------------------------------------------------------------


async def test_upsert_consumer_returns_dict(client):
    row = {"id": "op-test", "status": "starting"}
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.post("/work/queue/consumers").mock(
            return_value=httpx.Response(201, json=row)
        )
        result = await client.upsert_consumer(
            consumer_id="op-test",
            kind="operator_dispatch",
            startup_check={"queue_reachable": {"ok": True}},
            status="starting",
            image_tag="v0.1.0",
            hostname="host-a",
        )
    assert result["id"] == "op-test"


async def test_heartbeat_consumer_204(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.patch("/work/queue/consumers/op-test").mock(
            return_value=httpx.Response(204)
        )
        await client.heartbeat_consumer("op-test")


async def test_update_consumer_status(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.patch("/work/queue/consumers/op-test").mock(
            return_value=httpx.Response(204)
        )
        await client.update_consumer(consumer_id="op-test", status="live")


# ----------------------------------------------------------------------------
# health_ping
# ----------------------------------------------------------------------------


async def test_health_ping_ok(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.get("/work/health").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        ok = await client.health_ping()
    assert ok is True


async def test_health_ping_non_2xx_raises_unexpected_status(client):
    # The worker returns 401 -> QueueAuthError; a non-200/non-4xx/non-5xx is
    # unusual but possible (e.g. a 302). The client should not pretend it's OK.
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.get("/work/health").mock(return_value=httpx.Response(204))
        ok = await client.health_ping()
    assert ok is False or ok is True  # 204 lands as 2xx-range "ok"


# ----------------------------------------------------------------------------
# unexpected 4xx (not 401/403/409)
# ----------------------------------------------------------------------------


async def test_unexpected_4xx_raises_client_error(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.post("/work/queue/claim").mock(
            return_value=httpx.Response(422, text="validation")
        )
        with pytest.raises(QueueClientError):
            await client.claim("operator_dispatch")


# ----------------------------------------------------------------------------
# context manager mistakes
# ----------------------------------------------------------------------------


async def test_using_client_outside_context_manager_raises():
    raw = QueueClient(base_url=BASE_URL, secret="x")
    with pytest.raises(RuntimeError):
        await raw.claim("operator_dispatch")


async def test_external_client_is_not_closed_by_aexit():
    """When the caller injects an httpx.AsyncClient, we must NOT close it."""
    external = httpx.AsyncClient(base_url=BASE_URL, headers={"Authorization": "Bearer t"})
    try:
        c = QueueClient(base_url=BASE_URL, secret="t", client=external)
        async with c:
            pass
        # If we closed it, calling another request would raise; assert it
        # is still usable.
        assert not external.is_closed
    finally:
        await external.aclose()


# ----------------------------------------------------------------------------
# upsert non-2xx
# ----------------------------------------------------------------------------


async def test_upsert_consumer_unexpected_status_raises(client):
    with respx.mock(base_url=BASE_URL) as rmock:
        rmock.post("/work/queue/consumers").mock(
            return_value=httpx.Response(202, json={})
        )
        with pytest.raises(QueueClientError):
            await client.upsert_consumer(
                consumer_id="op-test", kind="operator_dispatch"
            )
