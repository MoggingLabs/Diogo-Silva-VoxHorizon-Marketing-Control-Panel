"""Tests for the resilient HTTP base (P5.7 / #370).

Every path is driven through ``httpx.MockTransport`` (no sockets) with an
injected ``sleep`` (no real waits) and an injected ``monotonic`` / ``rng`` so
backoff + the breaker's recovery clock are deterministic.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from src.services._http import (
    CircuitOpenError,
    PermanentError,
    ResilientHttpClient,
    RetryableError,
    _Breaker,
    backoff_delay,
    parse_retry_after,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _no_sleep(_delay: float) -> None:
    """A sleep that records nothing and returns immediately."""
    return None


class _RecordingSleep:
    """An async sleep stand-in that records every requested delay."""

    def __init__(self) -> None:
        self.delays: list[float] = []

    async def __call__(self, delay: float) -> None:
        self.delays.append(delay)


class _FakeClock:
    """A monotonic clock you can advance by hand."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


def _client(handler, **kwargs) -> ResilientHttpClient:
    """Build a ResilientHttpClient over a MockTransport handler."""
    kwargs.setdefault("sleep", _no_sleep)
    kwargs.setdefault("rng", lambda: 0.0)  # zero jitter unless overridden
    return ResilientHttpClient(
        base_url="https://api.example.test",
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


# ---------------------------------------------------------------------------
# parse_retry_after
# ---------------------------------------------------------------------------


def test_parse_retry_after_none_and_blank() -> None:
    assert parse_retry_after(None) is None
    assert parse_retry_after("") is None
    assert parse_retry_after("   ") is None


def test_parse_retry_after_delta_seconds() -> None:
    assert parse_retry_after("120") == 120.0
    # Negative deltas clamp to 0.
    assert parse_retry_after("-5") == 0.0


def test_parse_retry_after_http_date_future() -> None:
    # 60s in the future relative to a fixed now.
    now = 1_000_000.0
    # Wed, ... GMT — build from a known epoch via email.utils round-trip.
    from email.utils import formatdate

    header = formatdate(now + 60, usegmt=True)
    delay = parse_retry_after(header, now=now)
    assert delay is not None
    assert 59.0 <= delay <= 61.0


def test_parse_retry_after_http_date_past_clamps_zero() -> None:
    from email.utils import formatdate

    now = 2_000_000.0
    header = formatdate(now - 500, usegmt=True)
    assert parse_retry_after(header, now=now) == 0.0


def test_parse_retry_after_garbage_returns_none() -> None:
    assert parse_retry_after("not-a-date") is None


# ---------------------------------------------------------------------------
# backoff_delay
# ---------------------------------------------------------------------------


def test_backoff_full_jitter_window_grows() -> None:
    # rng=1.0 yields the full window; window = base * 2**(attempt-1).
    assert backoff_delay(1, base=0.5, cap=100, rng=lambda: 1.0) == 0.5
    assert backoff_delay(2, base=0.5, cap=100, rng=lambda: 1.0) == 1.0
    assert backoff_delay(3, base=0.5, cap=100, rng=lambda: 1.0) == 2.0


def test_backoff_caps_window() -> None:
    # A huge attempt is capped.
    assert backoff_delay(20, base=0.5, cap=5.0, rng=lambda: 1.0) == 5.0


def test_backoff_jitter_scales_window() -> None:
    # Half jitter on a 4.0 window.
    assert backoff_delay(3, base=1.0, cap=100, rng=lambda: 0.5) == 2.0


# ---------------------------------------------------------------------------
# _Breaker state machine
# ---------------------------------------------------------------------------


def test_breaker_opens_after_threshold() -> None:
    clock = _FakeClock()
    b = _Breaker(failure_threshold=3, recovery_timeout_s=10, monotonic=clock)
    assert b.allow() is True
    b.record_failure()
    b.record_failure()
    assert b.state == "closed"
    b.record_failure()  # third → trip
    assert b.state == "open"
    assert b.allow() is False  # fast-fail while open


def test_breaker_half_open_then_close_on_success() -> None:
    clock = _FakeClock()
    b = _Breaker(failure_threshold=1, recovery_timeout_s=10, monotonic=clock)
    b.record_failure()
    assert b.state == "open"
    assert b.allow() is False
    clock.advance(10)  # recovery window elapsed
    assert b.allow() is True  # half-open probe permitted
    assert b.state == "half_open"
    b.record_success()
    assert b.state == "closed"
    assert b.consecutive_failures == 0


def test_breaker_half_open_failure_reopens() -> None:
    clock = _FakeClock()
    b = _Breaker(failure_threshold=1, recovery_timeout_s=10, monotonic=clock)
    b.record_failure()
    clock.advance(10)
    assert b.allow() is True  # half-open
    b.record_failure()  # probe failed → reopen
    assert b.state == "open"
    assert b.allow() is False


def test_breaker_success_resets_failure_count() -> None:
    clock = _FakeClock()
    b = _Breaker(failure_threshold=3, recovery_timeout_s=10, monotonic=clock)
    b.record_failure()
    b.record_failure()
    b.record_success()
    assert b.consecutive_failures == 0
    assert b.state == "closed"


# ---------------------------------------------------------------------------
# ResilientHttpClient — retry behaviour
# ---------------------------------------------------------------------------


def test_429_then_200_retries_and_succeeds() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, json={"error": "slow down"})
        return httpx.Response(200, json={"ok": True})

    sleep = _RecordingSleep()
    client = _client(handler, sleep=sleep, rng=lambda: 1.0, backoff_base_s=0.5)
    resp = asyncio.run(client.get("/v"))
    assert resp.status_code == 200
    assert calls["n"] == 2
    assert sleep.delays == [0.5]  # one backoff between the two attempts


def test_retry_after_header_overrides_backoff() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "7"})
        return httpx.Response(200)

    sleep = _RecordingSleep()
    client = _client(handler, sleep=sleep)
    resp = asyncio.run(client.get("/v"))
    assert resp.status_code == 200
    assert sleep.delays == [7.0]  # honored Retry-After, not the jittered backoff


def test_500_exhausts_and_raises_retryable() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500, json={"error": "boom"})

    sleep = _RecordingSleep()
    client = _client(handler, sleep=sleep, max_attempts=4)
    with pytest.raises(RetryableError) as ei:
        asyncio.run(client.get("/v"))
    assert ei.value.status_code == 500
    assert calls["n"] == 4  # 1 + 3 retries
    assert len(sleep.delays) == 3  # backoff between each pair


def test_400_does_not_retry_raises_permanent() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, json={"error": "bad request"})

    client = _client(handler)
    with pytest.raises(PermanentError) as ei:
        asyncio.run(client.get("/v"))
    assert ei.value.status_code == 400
    assert ei.value.payload == {"error": "bad request"}
    assert calls["n"] == 1  # never retried


def test_404_is_permanent() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    client = _client(handler)
    with pytest.raises(PermanentError):
        asyncio.run(client.get("/v"))


def test_timeout_is_retryable_and_exhausts() -> None:
    class _TimeoutTransport(httpx.MockTransport):
        def __init__(self) -> None:
            super().__init__(lambda r: httpx.Response(200))

        async def handle_async_request(self, request):
            raise httpx.ReadTimeout("read timed out", request=request)

    client = ResilientHttpClient(
        base_url="https://api.example.test",
        transport=_TimeoutTransport(),
        sleep=_no_sleep,
        rng=lambda: 0.0,
        max_attempts=2,
    )
    with pytest.raises(RetryableError):
        asyncio.run(client.get("/v"))


def test_connect_error_is_retryable_then_succeeds() -> None:
    state = {"n": 0}

    class _FlakyTransport(httpx.MockTransport):
        def __init__(self) -> None:
            super().__init__(lambda r: httpx.Response(200, json={"ok": 1}))

        async def handle_async_request(self, request):
            state["n"] += 1
            if state["n"] == 1:
                raise httpx.ConnectError("connection refused", request=request)
            return await super().handle_async_request(request)

    client = ResilientHttpClient(
        base_url="https://api.example.test",
        transport=_FlakyTransport(),
        sleep=_no_sleep,
        rng=lambda: 0.0,
    )
    resp = asyncio.run(client.get("/v"))
    assert resp.status_code == 200
    assert state["n"] == 2


def test_non_httpx_request_error_is_permanent() -> None:
    class _BadTransport(httpx.MockTransport):
        def __init__(self) -> None:
            super().__init__(lambda r: httpx.Response(200))

        async def handle_async_request(self, request):
            # An httpx.HTTPError that is NOT a timeout/connect/read error.
            raise httpx.UnsupportedProtocol("nope", request=request)

    client = ResilientHttpClient(
        base_url="https://api.example.test",
        transport=_BadTransport(),
        sleep=_no_sleep,
    )
    with pytest.raises(PermanentError):
        asyncio.run(client.get("/v"))


# ---------------------------------------------------------------------------
# Circuit breaker — end to end through request()
# ---------------------------------------------------------------------------


def test_breaker_opens_and_fast_fails() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503)

    # threshold=2, single attempt per call so each call = 1 failure.
    client = _client(
        handler, max_attempts=1, failure_threshold=2, recovery_timeout_s=100
    )

    async def drive() -> None:
        with pytest.raises(RetryableError):
            await client.get("/v")  # failure 1
        with pytest.raises(RetryableError):
            await client.get("/v")  # failure 2 → trips open
        assert client.breaker_state("api.example.test") == "open"
        # Next call fast-fails WITHOUT hitting the transport.
        before = calls["n"]
        with pytest.raises(CircuitOpenError):
            await client.get("/v")
        assert calls["n"] == before  # no new request issued

    asyncio.run(drive())


def test_breaker_half_open_recovers() -> None:
    clock = _FakeClock()
    state = {"fail": True}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503 if state["fail"] else 200)

    client = ResilientHttpClient(
        base_url="https://api.example.test",
        transport=httpx.MockTransport(handler),
        sleep=_no_sleep,
        rng=lambda: 0.0,
        max_attempts=1,
        failure_threshold=1,
        recovery_timeout_s=30,
        monotonic=clock,
    )

    async def drive() -> None:
        with pytest.raises(RetryableError):
            await client.get("/v")  # trips open immediately (threshold=1)
        assert client.breaker_state("api.example.test") == "open"
        clock.advance(30)  # recovery window elapses
        state["fail"] = False  # upstream healthy again
        resp = await client.get("/v")  # half-open probe succeeds
        assert resp.status_code == 200
        assert client.breaker_state("api.example.test") == "closed"

    asyncio.run(drive())


def test_breaker_is_per_host() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "bad.example.test":
            return httpx.Response(503)
        return httpx.Response(200)

    client = ResilientHttpClient(
        transport=httpx.MockTransport(handler),
        sleep=_no_sleep,
        rng=lambda: 0.0,
        max_attempts=1,
        failure_threshold=1,
    )

    async def drive() -> None:
        with pytest.raises(RetryableError):
            await client.get("https://bad.example.test/v")
        assert client.breaker_state("bad.example.test") == "open"
        # A different host is unaffected.
        resp = await client.get("https://good.example.test/v")
        assert resp.status_code == 200
        assert client.breaker_state("good.example.test") == "closed"

    asyncio.run(drive())


# ---------------------------------------------------------------------------
# Lifecycle + ergonomics
# ---------------------------------------------------------------------------


def test_post_verb_and_correlation_id_passthrough() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["body"] = request.content
        return httpx.Response(200, json={"ok": True})

    client = _client(handler)
    resp = asyncio.run(
        client.post("/v", json={"a": 1}, correlation_id="cid-123")
    )
    assert resp.status_code == 200
    assert seen["method"] == "POST"
    assert b'"a"' in seen["body"]  # type: ignore[operator]


def test_async_context_manager_closes() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200)

    async def drive() -> None:
        async with ResilientHttpClient(
            base_url="https://api.example.test",
            transport=httpx.MockTransport(handler),
            sleep=_no_sleep,
        ) as client:
            resp = await client.get("/v")
            assert resp.status_code == 200
        # aclose is idempotent.
        await client.aclose()

    asyncio.run(drive())


def test_aclose_without_request_is_noop() -> None:
    client = ResilientHttpClient(base_url="https://x.test")
    asyncio.run(client.aclose())  # never opened a client — must not raise


def test_no_base_url_uses_absolute_url() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "abs.example.test"
        return httpx.Response(200)

    client = ResilientHttpClient(
        transport=httpx.MockTransport(handler),
        sleep=_no_sleep,
    )
    resp = asyncio.run(client.get("https://abs.example.test/path"))
    assert resp.status_code == 200


def test_safe_json_on_non_json_body_in_payload() -> None:
    # A retryable status with a non-JSON body — payload should be None, not crash.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b"<html>down</html>")

    client = _client(handler, max_attempts=1)
    with pytest.raises(RetryableError) as ei:
        asyncio.run(client.get("/v"))
    assert ei.value.payload is None
