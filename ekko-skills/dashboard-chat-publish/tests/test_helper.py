"""Tests for the ``dashboard-chat-publish`` helper.

All tests mock ``httpx.post`` so the suite runs offline. Coverage:

- Happy path (assistant role, no tool calls).
- Happy path with tool calls (content_type=tool_call, metadata jsonb).
- Role mapping (user / assistant / system).
- thread_id parsing (valid + every invalid shape).
- Role validation (unknown / wrong type).
- content validation (None / wrong type).
- Missing env vars (loud RuntimeError).
- HTTP error from Supabase surfaces as HTTPStatusError.
- Empty-body defensive RuntimeError.
- Non-list / non-dict body defensive RuntimeError.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

# The helper lives one directory up from this tests/ file. Make it
# importable without forcing a package install.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import helper  # noqa: E402  (path-mutation pattern)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default env: both Supabase vars set. Individual tests override."""
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")


class _FakeResponse:
    """Stand-in for ``httpx.Response`` covering only the surface the
    helper touches: ``status_code``, ``raise_for_status``, ``json``.
    """

    def __init__(
        self,
        status_code: int = 200,
        body: Any | None = None,
        *,
        request_url: str = "https://example.supabase.co/rest/v1/chat_messages",
    ) -> None:
        self.status_code = status_code
        self._body = body if body is not None else []
        self._request_url = request_url

    def raise_for_status(self) -> None:
        if 200 <= self.status_code < 300:
            return
        request = httpx.Request("POST", self._request_url)
        response = httpx.Response(self.status_code, request=request)
        raise httpx.HTTPStatusError(
            f"HTTP {self.status_code}",
            request=request,
            response=response,
        )

    def json(self) -> Any:
        return self._body


@pytest.fixture
def captured_post(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Capture the arguments passed to ``httpx.post`` and let the test
    set a response body."""
    captured: dict[str, Any] = {
        "url": None,
        "headers": None,
        "json": None,
        "timeout": None,
        "calls": 0,
    }

    def _fake_post(
        url: str,
        *,
        headers: dict[str, str],
        json: Any,
        timeout: float,
    ) -> _FakeResponse:
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        captured["timeout"] = timeout
        captured["calls"] += 1
        return captured["response"]

    captured["response"] = _FakeResponse(
        status_code=201,
        body=[
            {
                "id": "00000000-0000-0000-0000-000000000001",
                "creative_type": "video",
                "creative_id": "7b2c1d0e-1234-4abc-9def-0123456789ab",
                "author": "ekko",
                "content_type": "text",
                "content": "reply text",
                "metadata": {},
                "created_at": "2026-05-17T12:00:00Z",
            }
        ],
    )
    monkeypatch.setattr(helper.httpx, "post", _fake_post)
    return captured


# ---------------------------------------------------------------------------
# Happy paths
# ---------------------------------------------------------------------------


def test_publish_message_assistant_text(captured_post: dict[str, Any]) -> None:
    row = helper.publish_message(
        thread_id="video:7b2c1d0e-1234-4abc-9def-0123456789ab",
        role="assistant",
        content="reply text",
    )
    # Returned the first element of the PostgREST array.
    assert row["id"] == "00000000-0000-0000-0000-000000000001"
    assert row["author"] == "ekko"
    # URL points at PostgREST chat_messages endpoint.
    assert captured_post["url"] == (
        "https://example.supabase.co/rest/v1/chat_messages"
    )
    # Auth + prefer headers are set correctly.
    headers = captured_post["headers"]
    assert headers["apikey"] == "test-service-role-key"
    assert headers["Authorization"] == "Bearer test-service-role-key"
    assert headers["Content-Type"] == "application/json"
    assert headers["Prefer"] == "return=representation"
    # Body shape: text path, empty metadata, role mapped to ekko.
    body = captured_post["json"]
    assert body == {
        "creative_type": "video",
        "creative_id": "7b2c1d0e-1234-4abc-9def-0123456789ab",
        "author": "ekko",
        "content": "reply text",
        "content_type": "text",
        "metadata": {},
    }
    # Body is JSON-serialisable (sanity).
    json.dumps(body)
    assert captured_post["calls"] == 1


def test_publish_message_with_tool_calls(captured_post: dict[str, Any]) -> None:
    tool_calls = [
        {"name": "image_ad_prompting", "input": {"ratio": "9x16"}},
        {"name": "image_ad_prompting", "input": {"ratio": "1x1"}},
    ]
    helper.publish_message(
        thread_id="image:11111111-2222-3333-4444-555555555555",
        role="assistant",
        content="generating two ratios",
        tool_calls=tool_calls,
    )
    body = captured_post["json"]
    assert body["content_type"] == "tool_call"
    assert body["metadata"] == {"tool_calls": tool_calls}
    assert body["creative_type"] == "image"
    assert body["creative_id"] == "11111111-2222-3333-4444-555555555555"


def test_publish_message_user_role(captured_post: dict[str, Any]) -> None:
    helper.publish_message(
        thread_id="image:abc",
        role="user",
        content="hello",
    )
    assert captured_post["json"]["author"] == "user"


def test_publish_message_system_role(captured_post: dict[str, Any]) -> None:
    helper.publish_message(
        thread_id="video:xyz",
        role="system",
        content="tool produced 3 clips",
    )
    assert captured_post["json"]["author"] == "system"


def test_publish_message_empty_content_allowed(
    captured_post: dict[str, Any],
) -> None:
    helper.publish_message(
        thread_id="image:abc",
        role="assistant",
        content="",
        tool_calls=[{"name": "noop"}],
    )
    assert captured_post["json"]["content"] == ""


def test_publish_message_dict_body_returned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Defensive: if PostgREST is ever configured to return a single
    object instead of a list, the helper still surfaces the row."""

    def _post_dict(url: str, **_: Any) -> _FakeResponse:
        return _FakeResponse(
            status_code=201,
            body={"id": "abc", "author": "ekko"},
        )

    monkeypatch.setattr(helper.httpx, "post", _post_dict)
    row = helper.publish_message(
        thread_id="image:abc",
        role="assistant",
        content="hi",
    )
    assert row == {"id": "abc", "author": "ekko"}


def test_url_trailing_slash_stripped(
    monkeypatch: pytest.MonkeyPatch,
    captured_post: dict[str, Any],
) -> None:
    """SUPABASE_URL with a trailing slash should not double up on
    ``//rest/v1/...``."""
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co/")
    helper.publish_message(
        thread_id="image:abc",
        role="assistant",
        content="hi",
    )
    assert captured_post["url"] == (
        "https://example.supabase.co/rest/v1/chat_messages"
    )


def test_request_timeout_is_set(captured_post: dict[str, Any]) -> None:
    helper.publish_message(
        thread_id="image:abc",
        role="assistant",
        content="hi",
    )
    assert captured_post["timeout"] == 10.0


# ---------------------------------------------------------------------------
# thread_id parsing
# ---------------------------------------------------------------------------


def test_thread_id_missing_colon_raises() -> None:
    with pytest.raises(ValueError, match="thread_id"):
        helper.publish_message(
            thread_id="no-colon",
            role="assistant",
            content="hi",
        )


def test_thread_id_bad_prefix_raises() -> None:
    with pytest.raises(ValueError, match="prefix must be 'image' or 'video'"):
        helper.publish_message(
            thread_id="podcast:abc",
            role="assistant",
            content="hi",
        )


def test_thread_id_empty_suffix_raises() -> None:
    with pytest.raises(ValueError, match="missing the creative_id"):
        helper.publish_message(
            thread_id="image:",
            role="assistant",
            content="hi",
        )


def test_thread_id_non_string_raises() -> None:
    with pytest.raises(ValueError, match="thread_id"):
        helper.publish_message(
            thread_id=123,  # type: ignore[arg-type]
            role="assistant",
            content="hi",
        )


# ---------------------------------------------------------------------------
# role validation
# ---------------------------------------------------------------------------


def test_unknown_role_raises() -> None:
    with pytest.raises(ValueError, match="role must be one of"):
        helper.publish_message(
            thread_id="image:abc",
            role="robot",
            content="hi",
        )


def test_non_string_role_raises() -> None:
    with pytest.raises(ValueError, match="role must be a string"):
        helper.publish_message(
            thread_id="image:abc",
            role=42,  # type: ignore[arg-type]
            content="hi",
        )


# ---------------------------------------------------------------------------
# content validation
# ---------------------------------------------------------------------------


def test_none_content_raises() -> None:
    with pytest.raises(ValueError, match="content must not be None"):
        helper.publish_message(
            thread_id="image:abc",
            role="assistant",
            content=None,  # type: ignore[arg-type]
        )


def test_non_string_content_raises() -> None:
    with pytest.raises(ValueError, match="content must be a string"):
        helper.publish_message(
            thread_id="image:abc",
            role="assistant",
            content=123,  # type: ignore[arg-type]
        )


# ---------------------------------------------------------------------------
# env vars
# ---------------------------------------------------------------------------


def test_missing_supabase_url_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="SUPABASE_URL"):
        helper.publish_message(
            thread_id="image:abc",
            role="assistant",
            content="hi",
        )


def test_missing_service_role_key_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    with pytest.raises(RuntimeError, match="SUPABASE_SERVICE_ROLE_KEY"):
        helper.publish_message(
            thread_id="image:abc",
            role="assistant",
            content="hi",
        )


# ---------------------------------------------------------------------------
# Supabase failure modes
# ---------------------------------------------------------------------------


def test_supabase_non_2xx_surfaces_http_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _post_500(url: str, **_: Any) -> _FakeResponse:
        return _FakeResponse(status_code=500, body={"error": "boom"})

    monkeypatch.setattr(helper.httpx, "post", _post_500)
    with pytest.raises(httpx.HTTPStatusError):
        helper.publish_message(
            thread_id="image:abc",
            role="assistant",
            content="hi",
        )


def test_supabase_empty_list_response_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _post_empty(url: str, **_: Any) -> _FakeResponse:
        return _FakeResponse(status_code=201, body=[])

    monkeypatch.setattr(helper.httpx, "post", _post_empty)
    with pytest.raises(RuntimeError, match="empty representation"):
        helper.publish_message(
            thread_id="image:abc",
            role="assistant",
            content="hi",
        )


def test_supabase_unexpected_body_shape_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _post_string(url: str, **_: Any) -> _FakeResponse:
        # Not a list, not a dict.
        return _FakeResponse(status_code=201, body="surprise string")

    monkeypatch.setattr(helper.httpx, "post", _post_string)
    with pytest.raises(RuntimeError, match="Unexpected Supabase response"):
        helper.publish_message(
            thread_id="image:abc",
            role="assistant",
            content="hi",
        )
