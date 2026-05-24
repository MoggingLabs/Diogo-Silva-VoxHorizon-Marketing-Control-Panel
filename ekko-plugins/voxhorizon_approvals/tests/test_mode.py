"""Tests for the operator-controlled approval mode cache (Wave 24).

Coverage targets:

* :func:`fetch_mode` hits the worker on cold cache
* :func:`fetch_mode` re-uses cached value within MODE_CACHE_TTL_S
* :func:`fetch_mode` refreshes after the TTL expires
* Network failure / timeout / non-200 / non-JSON / bad payload fall
  back to ASK (or last cached value when present)
* Missing env vars degrade silently to ASK without caching
* ``ModeState.effective_mode`` collapses expired AUTO_APPROVE → ASK
* ``ModeState.effective_mode`` honors un-expired AUTO_APPROVE
* ``ModeState.effective_mode`` honors HALT
* :func:`clear_cache` evicts the in-process cache
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from voxhorizon_approvals import mode as mode_module
from voxhorizon_approvals.mode import (
    MAX_AUTO_APPROVE_TTL_S,
    MODE_CACHE_TTL_S,
    ModeState,
    clear_cache,
    fetch_mode,
)


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    clear_cache()
    yield
    clear_cache()


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "VOXHORIZON_APPROVAL_WORKER_URL", "http://worker.test:8000"
    )
    monkeypatch.setenv("VOXHORIZON_APPROVAL_TOKEN", "test-token")


def _mock_response(handler):
    transport = httpx.MockTransport(handler)
    return httpx.Client(transport=transport)


# ---------------------------------------------------------------------------
# Happy path + caching
# ---------------------------------------------------------------------------


def test_fetch_mode_returns_ask_default(env: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "mode": "ASK",
                "expires_at": None,
                "set_by": "dashboard",
                "set_at": "2026-05-19T00:00:00+00:00",
                "note": None,
            },
        )

    with _mock_response(handler) as client:
        state = fetch_mode(http_client=client)
    assert state.mode == "ASK"
    assert state.expires_at is None
    assert state.effective_mode == "ASK"


def test_fetch_mode_returns_auto_approve_with_expiry(env: None) -> None:
    deadline = (
        datetime.now(timezone.utc) + timedelta(hours=2)
    ).isoformat()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "mode": "AUTO_APPROVE",
                "expires_at": deadline,
                "set_by": "dashboard",
                "set_at": "x",
                "note": "batch",
            },
        )

    with _mock_response(handler) as client:
        state = fetch_mode(http_client=client)
    assert state.mode == "AUTO_APPROVE"
    assert state.effective_mode == "AUTO_APPROVE"


def test_fetch_mode_returns_halt(env: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "mode": "HALT",
                "expires_at": None,
                "set_by": "dashboard",
                "set_at": "x",
                "note": None,
            },
        )

    with _mock_response(handler) as client:
        state = fetch_mode(http_client=client)
    assert state.mode == "HALT"
    assert state.effective_mode == "HALT"


def test_fetch_mode_uses_cache_within_ttl(env: None) -> None:
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(
            200,
            json={
                "mode": "HALT",
                "expires_at": None,
                "set_by": None,
                "set_at": "",
                "note": None,
            },
        )

    with _mock_response(handler) as client:
        s1 = fetch_mode(http_client=client)
        s2 = fetch_mode(http_client=client)
        assert s1.mode == "HALT"
        assert s2.mode == "HALT"

    assert calls["count"] == 1, "second call must hit cache"


def test_fetch_mode_refreshes_after_ttl(
    env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"count": 0}
    fake_time = {"now": 1000.0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(
            200,
            json={
                "mode": "ASK",
                "expires_at": None,
                "set_by": None,
                "set_at": "",
                "note": None,
            },
        )

    monkeypatch.setattr(mode_module, "_now", lambda: fake_time["now"])

    with _mock_response(handler) as client:
        fetch_mode(http_client=client)
        # Advance past TTL.
        fake_time["now"] += MODE_CACHE_TTL_S + 1
        fetch_mode(http_client=client)

    assert calls["count"] == 2


def test_clear_cache_forces_refresh(env: None) -> None:
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(
            200,
            json={
                "mode": "ASK",
                "expires_at": None,
                "set_by": None,
                "set_at": "",
                "note": None,
            },
        )

    with _mock_response(handler) as client:
        fetch_mode(http_client=client)
        clear_cache()
        fetch_mode(http_client=client)

    assert calls["count"] == 2


# ---------------------------------------------------------------------------
# Failure paths — all degrade to ASK or last cached value
# ---------------------------------------------------------------------------


def test_fetch_mode_missing_env_returns_ask_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(
        "VOXHORIZON_APPROVAL_WORKER_URL", raising=False
    )
    monkeypatch.delenv(
        "VOXHORIZON_APPROVAL_TOKEN", raising=False
    )

    state = fetch_mode()
    assert state.mode == "ASK"


def test_fetch_mode_network_failure_returns_ask_default(
    env: None,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failure", request=request)

    with _mock_response(handler) as client:
        state = fetch_mode(http_client=client)
    assert state.mode == "ASK"


def test_fetch_mode_network_failure_returns_cached_when_available(
    env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A blip after a successful fetch returns the previously-cached value."""
    seq = iter(
        [
            httpx.Response(
                200,
                json={
                    "mode": "HALT",
                    "expires_at": None,
                    "set_by": None,
                    "set_at": "",
                    "note": None,
                },
            ),
            "boom",
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        nxt = next(seq)
        if nxt == "boom":
            raise httpx.ConnectError("dns failure", request=request)
        return nxt

    fake_time = {"now": 1000.0}
    monkeypatch.setattr(mode_module, "_now", lambda: fake_time["now"])

    with _mock_response(handler) as client:
        s1 = fetch_mode(http_client=client)
        # Past TTL → forces refresh.
        fake_time["now"] += MODE_CACHE_TTL_S + 1
        s2 = fetch_mode(http_client=client)

    assert s1.mode == "HALT"
    # Second fetch fails — we get the cached HALT back.
    assert s2.mode == "HALT"


def test_fetch_mode_timeout_returns_ask_default(env: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    with _mock_response(handler) as client:
        state = fetch_mode(http_client=client)
    assert state.mode == "ASK"


def test_fetch_mode_500_returns_ask_default(env: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    with _mock_response(handler) as client:
        state = fetch_mode(http_client=client)
    assert state.mode == "ASK"


def test_fetch_mode_non_200_returns_cached_when_available(
    env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    seq = iter(
        [
            httpx.Response(
                200,
                json={
                    "mode": "AUTO_APPROVE",
                    "expires_at": (
                        datetime.now(timezone.utc) + timedelta(hours=4)
                    ).isoformat(),
                    "set_by": None,
                    "set_at": "",
                    "note": None,
                },
            ),
            httpx.Response(500, text="boom"),
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return next(seq)

    fake_time = {"now": 1000.0}
    monkeypatch.setattr(mode_module, "_now", lambda: fake_time["now"])

    with _mock_response(handler) as client:
        s1 = fetch_mode(http_client=client)
        fake_time["now"] += MODE_CACHE_TTL_S + 1
        s2 = fetch_mode(http_client=client)

    assert s1.mode == "AUTO_APPROVE"
    # Cached fallback after 500 — keeps last-known AUTO_APPROVE.
    assert s2.mode == "AUTO_APPROVE"


def test_fetch_mode_non_json_returns_ask_default(env: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not json", headers={"content-type": "text/plain"})

    with _mock_response(handler) as client:
        state = fetch_mode(http_client=client)
    assert state.mode == "ASK"


def test_fetch_mode_non_json_returns_cached_when_available(
    env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    seq = iter(
        [
            httpx.Response(
                200,
                json={
                    "mode": "HALT",
                    "expires_at": None,
                    "set_by": None,
                    "set_at": "",
                    "note": None,
                },
            ),
            httpx.Response(
                200,
                content=b"not json",
                headers={"content-type": "text/plain"},
            ),
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return next(seq)

    fake_time = {"now": 1000.0}
    monkeypatch.setattr(mode_module, "_now", lambda: fake_time["now"])

    with _mock_response(handler) as client:
        s1 = fetch_mode(http_client=client)
        fake_time["now"] += MODE_CACHE_TTL_S + 1
        s2 = fetch_mode(http_client=client)

    assert s1.mode == "HALT"
    assert s2.mode == "HALT"


def test_fetch_mode_non_dict_payload_returns_ask(env: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=["not", "a", "dict"])

    with _mock_response(handler) as client:
        state = fetch_mode(http_client=client)
    assert state.mode == "ASK"


def test_fetch_mode_invalid_mode_returns_ask(env: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "mode": "INVENT_NEW_MODE",
                "expires_at": None,
                "set_by": None,
                "set_at": "",
                "note": None,
            },
        )

    with _mock_response(handler) as client:
        state = fetch_mode(http_client=client)
    assert state.mode == "ASK"


# ---------------------------------------------------------------------------
# ModeState.effective_mode
# ---------------------------------------------------------------------------


def test_effective_mode_ask_is_ask() -> None:
    s = ModeState(
        mode="ASK", expires_at=None, set_by=None, set_at="", note=None
    )
    assert s.effective_mode == "ASK"


def test_effective_mode_halt_is_halt() -> None:
    s = ModeState(
        mode="HALT", expires_at=None, set_by=None, set_at="", note=None
    )
    assert s.effective_mode == "HALT"


def test_effective_mode_unexpired_auto_approve_is_auto_approve() -> None:
    deadline = (
        datetime.now(timezone.utc) + timedelta(hours=1)
    ).isoformat()
    s = ModeState(
        mode="AUTO_APPROVE",
        expires_at=deadline,
        set_by=None,
        set_at="",
        note=None,
    )
    assert s.effective_mode == "AUTO_APPROVE"


def test_effective_mode_expired_auto_approve_drops_to_ask() -> None:
    deadline = (
        datetime.now(timezone.utc) - timedelta(seconds=1)
    ).isoformat()
    s = ModeState(
        mode="AUTO_APPROVE",
        expires_at=deadline,
        set_by=None,
        set_at="",
        note=None,
    )
    assert s.effective_mode == "ASK"


def test_effective_mode_auto_approve_without_expiry_drops_to_ask() -> None:
    """Malformed row (AUTO_APPROVE + null expires_at) is treated as ASK."""
    s = ModeState(
        mode="AUTO_APPROVE",
        expires_at=None,
        set_by=None,
        set_at="",
        note=None,
    )
    assert s.effective_mode == "ASK"


def test_effective_mode_auto_approve_with_unparseable_expiry_drops_to_ask() -> None:
    s = ModeState(
        mode="AUTO_APPROVE",
        expires_at="not-a-timestamp",
        set_by=None,
        set_at="",
        note=None,
    )
    assert s.effective_mode == "ASK"


def test_effective_mode_handles_naive_expiry() -> None:
    """If the worker ever emits a naive timestamp, treat as UTC."""
    deadline = (
        datetime.now(timezone.utc) + timedelta(hours=1)
    ).replace(tzinfo=None).isoformat()
    set_at = datetime.now(timezone.utc).isoformat()
    s = ModeState(
        mode="AUTO_APPROVE",
        expires_at=deadline,
        set_by=None,
        set_at=set_at,
        note=None,
    )
    assert s.effective_mode == "AUTO_APPROVE"


# ---------------------------------------------------------------------------
# E6.5 — AUTO_APPROVE TTL cap (MAX_AUTO_APPROVE_TTL_S)
# ---------------------------------------------------------------------------


def test_max_auto_approve_ttl_is_at_most_one_hour() -> None:
    """The plugin's hard cap on the AUTO_APPROVE window is <= 1 hour."""
    assert MAX_AUTO_APPROVE_TTL_S <= 3600


def test_effective_mode_clamps_overlong_ttl_to_ask() -> None:
    """A 24h AUTO_APPROVE window (over the cap) is NOT honored past the cap.

    set_at was 90 minutes ago; expires_at is 22.5h in the future (a stored
    24h window). Because set_at + cap (1h) is already in the past, the
    effective deadline is clamped and the mode drops to ASK — even though
    the stored expires_at is still far in the future.
    """
    now = datetime.now(timezone.utc)
    set_at = (now - timedelta(minutes=90)).isoformat()
    expires_at = (now + timedelta(hours=22, minutes=30)).isoformat()
    s = ModeState(
        mode="AUTO_APPROVE",
        expires_at=expires_at,
        set_by="dashboard",
        set_at=set_at,
        note=None,
    )
    assert s.effective_mode == "ASK"


def test_effective_mode_honors_window_within_cap() -> None:
    """A window set 10 minutes ago with a (capped) 1h limit is still live."""
    now = datetime.now(timezone.utc)
    set_at = (now - timedelta(minutes=10)).isoformat()
    # Even a stored 24h expiry is fine while set_at + cap is in the future.
    expires_at = (now + timedelta(hours=24)).isoformat()
    s = ModeState(
        mode="AUTO_APPROVE",
        expires_at=expires_at,
        set_by="dashboard",
        set_at=set_at,
        note=None,
    )
    # set_at + 1h cap is ~50 min out → still AUTO_APPROVE.
    assert s.effective_mode == "AUTO_APPROVE"


def test_effective_mode_short_ttl_still_honored_before_expiry() -> None:
    """A legitimate short window (under the cap) is honored until expiry."""
    now = datetime.now(timezone.utc)
    set_at = (now - timedelta(minutes=5)).isoformat()
    expires_at = (now + timedelta(minutes=25)).isoformat()
    s = ModeState(
        mode="AUTO_APPROVE",
        expires_at=expires_at,
        set_by="dashboard",
        set_at=set_at,
        note=None,
    )
    assert s.effective_mode == "AUTO_APPROVE"


def test_effective_mode_caps_from_now_when_set_at_missing() -> None:
    """With set_at absent, an overlong expiry is clamped to now + cap.

    A stored 24h expiry but no set_at: the conservative fallback caps the
    window to now + 1h. Since the expiry is far beyond that, the mode is
    still AUTO_APPROVE *now* (within the cap-from-now) — the cap bites only
    after an hour. We assert the nearer-term behavior: it is honored now.
    """
    now = datetime.now(timezone.utc)
    expires_at = (now + timedelta(hours=24)).isoformat()
    s = ModeState(
        mode="AUTO_APPROVE",
        expires_at=expires_at,
        set_by="dashboard",
        set_at="",
        note=None,
    )
    assert s.effective_mode == "AUTO_APPROVE"


def test_effective_mode_caps_from_now_when_set_at_unparseable() -> None:
    """An unparseable set_at falls back to the conservative now + cap ceiling
    rather than trusting the (overlong) stored expiry indefinitely."""
    now = datetime.now(timezone.utc)
    expires_at = (now + timedelta(hours=24)).isoformat()
    s = ModeState(
        mode="AUTO_APPROVE",
        expires_at=expires_at,
        set_by="dashboard",
        set_at="not-a-timestamp",
        note=None,
    )
    # Honored now (within now + cap); the cap would bite after an hour.
    assert s.effective_mode == "AUTO_APPROVE"
