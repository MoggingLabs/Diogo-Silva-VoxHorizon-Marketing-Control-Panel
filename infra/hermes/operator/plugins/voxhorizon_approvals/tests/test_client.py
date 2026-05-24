"""Unit tests for :mod:`client` — synchronous HTTP + in-process cache.

Strategy: use httpx's :class:`httpx.MockTransport` to drive the
``ApprovalClient`` end-to-end without a real network. That gives us
realistic request/response shapes (URL, headers, JSON body) while
keeping the test deterministic.
"""

from __future__ import annotations

import json
import time

import httpx
import pytest

from voxhorizon_approvals.client import (
    APPROVAL_PATH,
    ApprovalClient,
    ApprovalClientError,
    ApprovalVerdict,
    _approval_id_from_tool_call,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_client(
    *,
    handler,
    worker_url: str = "http://worker.test:8000",
    token: str = "test-token",
    timeout_s: int = 30,
    cache_ttl_s: float = 60.0,
) -> ApprovalClient:
    """Build an ``ApprovalClient`` backed by an httpx ``MockTransport``."""
    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport)
    return ApprovalClient(
        worker_url=worker_url,
        token=token,
        default_timeout_s=timeout_s,
        cache_ttl_s=cache_ttl_s,
        http_client=http,
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_request_approval_happy_path_approved() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("Authorization")
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"decision": "approved", "notes": "looks fine"},
        )

    client = _make_client(handler=handler)
    verdict = client.request_approval(
        tool_name="kie_generate",
        args={"prompt": "hi"},
        session_id="sess-1",
        tool_call_id="tc-1",
        risk_class="spend",
        context={"brief_id": "b-9"},
    )
    assert verdict == ApprovalVerdict(decision="approved", notes="looks fine")
    # The cache now serves identical repeats without going to the network.
    assert client.cache_get("sess-1", "kie_generate", {"prompt": "hi"}) == verdict

    # Wire-shape sanity.
    assert captured["url"].endswith(APPROVAL_PATH)
    assert captured["auth"] == "Bearer test-token"
    body = captured["body"]
    assert body["tool_name"] == "kie_generate"
    assert body["tool_args"] == {"prompt": "hi"}
    assert body["ekko_session_id"] == "sess-1"
    assert body["ekko_tool_call_id"] == "tc-1"
    assert body["risk_class"] == "spend"
    assert body["context"] == {"brief_id": "b-9"}
    assert body["timeout_s"] == 30  # default from _make_client
    # approval_id is deterministic per tool_call_id.
    assert body["approval_id"] == _approval_id_from_tool_call("tc-1")


def test_request_approval_approved_with_caveat_is_cached() -> None:
    """approved_with_caveat is treated as approved for cache purposes."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"decision": "approved_with_caveat", "notes": "low budget"},
        )

    client = _make_client(handler=handler)
    verdict = client.request_approval(
        tool_name="elevenlabs_tts",
        args={"text": "x"},
        session_id="sess-1",
        tool_call_id="tc-2",
    )
    assert verdict.decision == "approved_with_caveat"
    assert client.cache_get("sess-1", "elevenlabs_tts", {"text": "x"}) == verdict


def test_request_approval_rejected_is_not_cached() -> None:
    """Rejections must not be cached — operator can change their mind."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"decision": "rejected", "notes": "no go"}
        )

    client = _make_client(handler=handler)
    verdict = client.request_approval(
        tool_name="send_email",
        args={"to": "x@example.com"},
        session_id="sess-1",
        tool_call_id="tc-3",
    )
    assert verdict.decision == "rejected"
    assert client.cache_get("sess-1", "send_email", {"to": "x@example.com"}) is None


def test_request_approval_respects_timeout_override() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"decision": "approved", "notes": None})

    client = _make_client(handler=handler, timeout_s=30)
    client.request_approval(
        tool_name="post_slack",
        args={},
        session_id="sess-1",
        tool_call_id="tc-4",
        timeout_s=120,  # overrides default
    )
    assert captured["body"]["timeout_s"] == 120


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


def test_request_approval_timeout_is_fail_closed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timed out", request=request)

    client = _make_client(handler=handler)
    with pytest.raises(ApprovalClientError, match="timed out"):
        client.request_approval(
            tool_name="send_email",
            args={},
            session_id="sess-1",
            tool_call_id="tc-5",
        )


def test_request_approval_connect_error_is_fail_closed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failure", request=request)

    client = _make_client(handler=handler)
    with pytest.raises(ApprovalClientError, match="unreachable"):
        client.request_approval(
            tool_name="send_email",
            args={},
            session_id="sess-1",
            tool_call_id="tc-6",
        )


def test_request_approval_5xx_is_fail_closed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="overloaded")

    client = _make_client(handler=handler)
    with pytest.raises(ApprovalClientError, match="503"):
        client.request_approval(
            tool_name="send_email",
            args={},
            session_id="sess-1",
            tool_call_id="tc-7",
        )


def test_request_approval_401_surfaces_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="bad token")

    client = _make_client(handler=handler)
    with pytest.raises(ApprovalClientError, match="401"):
        client.request_approval(
            tool_name="send_email",
            args={},
            session_id="sess-1",
            tool_call_id="tc-8",
        )


def test_request_approval_non_json_body_fails_closed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"<html>not json</html>",
            headers={"content-type": "text/html"},
        )

    client = _make_client(handler=handler)
    with pytest.raises(ApprovalClientError, match="non-JSON"):
        client.request_approval(
            tool_name="send_email",
            args={},
            session_id="sess-1",
            tool_call_id="tc-9",
        )


def test_request_approval_missing_decision_fails_closed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"notes": "lol no decision"})

    client = _make_client(handler=handler)
    with pytest.raises(ApprovalClientError, match="invalid decision"):
        client.request_approval(
            tool_name="send_email",
            args={},
            session_id="sess-1",
            tool_call_id="tc-10",
        )


def test_request_approval_non_string_decision_fails_closed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"decision": 42, "notes": None})

    client = _make_client(handler=handler)
    with pytest.raises(ApprovalClientError, match="invalid decision"):
        client.request_approval(
            tool_name="send_email",
            args={},
            session_id="sess-1",
            tool_call_id="tc-11",
        )


def test_request_approval_non_string_notes_fails_closed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"decision": "approved", "notes": ["array"]}
        )

    client = _make_client(handler=handler)
    with pytest.raises(ApprovalClientError, match="non-string notes"):
        client.request_approval(
            tool_name="send_email",
            args={},
            session_id="sess-1",
            tool_call_id="tc-12",
        )


def test_request_approval_non_object_body_fails_closed() -> None:
    """A JSON array (not an object) violates the contract."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=["approved"])

    client = _make_client(handler=handler)
    with pytest.raises(ApprovalClientError, match="invalid decision"):
        client.request_approval(
            tool_name="send_email",
            args={},
            session_id="sess-1",
            tool_call_id="tc-13",
        )


# ---------------------------------------------------------------------------
# Env-var resolution
# ---------------------------------------------------------------------------


def test_missing_worker_url_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("VOXHORIZON_APPROVAL_WORKER_URL", raising=False)
    monkeypatch.setenv("VOXHORIZON_APPROVAL_TOKEN", "tok")
    client = ApprovalClient()
    with pytest.raises(
        ApprovalClientError, match="VOXHORIZON_APPROVAL_WORKER_URL"
    ):
        client.request_approval(
            tool_name="send_email",
            args={},
            session_id="s",
            tool_call_id="tc",
        )


def test_missing_token_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "VOXHORIZON_APPROVAL_WORKER_URL", "http://worker:8000"
    )
    monkeypatch.delenv("VOXHORIZON_APPROVAL_TOKEN", raising=False)
    client = ApprovalClient()
    with pytest.raises(
        ApprovalClientError, match="VOXHORIZON_APPROVAL_TOKEN"
    ):
        client.request_approval(
            tool_name="send_email",
            args={},
            session_id="s",
            tool_call_id="tc",
        )


def test_env_var_strips_whitespace_and_trailing_slash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(
            200, json={"decision": "approved", "notes": None}
        )

    monkeypatch.setenv(
        "VOXHORIZON_APPROVAL_WORKER_URL", "  http://worker:8000///  "
    )
    monkeypatch.setenv("VOXHORIZON_APPROVAL_TOKEN", "  tok  ")
    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport)
    client = ApprovalClient(http_client=http)
    client.request_approval(
        tool_name="send_email",
        args={},
        session_id="s",
        tool_call_id="tc",
    )
    # No double-slash, trailing whitespace gone.
    assert captured["url"] == f"http://worker:8000{APPROVAL_PATH}"


# ---------------------------------------------------------------------------
# Cache behaviour
# ---------------------------------------------------------------------------


def test_cache_isolated_per_session() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"decision": "approved", "notes": None}
        )

    client = _make_client(handler=handler)
    client.request_approval(
        tool_name="send_email",
        args={"to": "a"},
        session_id="sess-A",
        tool_call_id="tc-1",
    )
    assert client.cache_get("sess-A", "send_email", {"to": "a"}) is not None
    # Different session — no hit.
    assert client.cache_get("sess-B", "send_email", {"to": "a"}) is None


def test_cache_expires() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"decision": "approved", "notes": None}
        )

    client = _make_client(handler=handler, cache_ttl_s=0.05)
    client.request_approval(
        tool_name="send_email",
        args={"to": "a"},
        session_id="sess-A",
        tool_call_id="tc-1",
    )
    assert client.cache_get("sess-A", "send_email", {"to": "a"}) is not None
    time.sleep(0.1)
    assert client.cache_get("sess-A", "send_email", {"to": "a"}) is None


def test_cache_clear_single_session() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"decision": "approved", "notes": None}
        )

    client = _make_client(handler=handler)
    client.request_approval(
        tool_name="send_email",
        args={},
        session_id="sess-A",
        tool_call_id="t1",
    )
    client.request_approval(
        tool_name="send_email",
        args={},
        session_id="sess-B",
        tool_call_id="t2",
    )
    client.cache_clear("sess-A")
    assert client.cache_get("sess-A", "send_email", {}) is None
    assert client.cache_get("sess-B", "send_email", {}) is not None


def test_cache_clear_all() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"decision": "approved", "notes": None}
        )

    client = _make_client(handler=handler)
    client.request_approval(
        tool_name="send_email",
        args={},
        session_id="sess-A",
        tool_call_id="t1",
    )
    client.cache_clear()
    assert client.cache_get("sess-A", "send_email", {}) is None


def test_cache_put_and_get_directly() -> None:
    """Direct cache surface — useful for tests + future warm-cache hooks."""
    client = ApprovalClient(worker_url="http://x", token="t")
    verdict = ApprovalVerdict(decision="approved", notes="x")
    client.cache_put("s", "send_email", {"a": 1}, verdict)
    assert client.cache_get("s", "send_email", {"a": 1}) == verdict
    # Different args, no hit.
    assert client.cache_get("s", "send_email", {"a": 2}) is None


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


def test_close_closes_owned_client() -> None:
    """Closing the wrapper closes the lazily-built httpx client."""
    client = ApprovalClient(worker_url="http://x", token="t")
    # Force lazy build by hitting the resolver path; we don't need a
    # round-trip — just touch the http client through the public
    # method. We'll call the private _ensure_client directly so we
    # don't have to mock a transport here.
    client._ensure_client(30)
    assert client._http_client is not None
    client.close()
    assert client._http_client is None


def test_close_does_not_close_external_client() -> None:
    """If the caller provided the http client, we don't own it."""
    external = httpx.Client()
    client = ApprovalClient(
        worker_url="http://x", token="t", http_client=external
    )
    client.close()
    # External still usable.
    assert not external.is_closed
    external.close()


def test_approval_id_is_deterministic_per_tool_call() -> None:
    a = _approval_id_from_tool_call("tc-1")
    b = _approval_id_from_tool_call("tc-1")
    c = _approval_id_from_tool_call("tc-2")
    assert a == b
    assert a != c
    # Must be UUID-like (36 chars with dashes) so the worker's
    # pydantic ``min_length=1`` is satisfied + future schema tightening
    # to ``UUID4`` is straightforward.
    assert len(a) == 36 and a.count("-") == 4
