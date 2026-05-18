"""Tests for the HI-17 approval notifications fan-out helper (Slack pivot).

The module is small but every branch matters because it's fire-and-forget —
a regression here is silent (no error surfaces to the operator). We cover:

* :func:`is_high_urgency` truth table (risk class, cost edges, garbage in)
* Push fan-out always fires (low-urgency stays inside the push branch)
* Slack fan-out only fires for high-urgency rows
* External-write risk → Slack
* Cost > $50 → Slack
* Cost == $50 → no Slack (strict greater-than)
* Cost is None → no Slack
* Missing env config → Slack skipped, push still runs
* Push failure does NOT skip the Slack step (independent branches)
* Slack failure (non-ok body, network error) logs but never raises
* Block Kit shape: header, context, cost, code-fenced args, primary button
* Args sanitization: keys matching sensitive patterns are redacted
* Args truncation: huge payloads collapse to ≤ budget + ellipsis
* Dashboard URL respects DASHBOARD_BASE_URL env override
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from src.services import approval_notifications as notif
from src.services.approval_notifications import (
    APPROVAL_PUSH_KIND,
    HIGH_URGENCY_COST_THRESHOLD,
    SLACK_API_URL,
    fan_out,
    is_high_urgency,
)
from src.services.push_delivery import PushPayload


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _row(
    *,
    approval_id: str = "ap-1",
    tool_name: str = "MetaAds.update_ad",
    risk_class: str | None = "filesystem",
    estimated_cost: float | None = 0.0,
    skill_name: str | None = "marketing-control",
    extra_context: dict[str, Any] | None = None,
    tool_args: dict[str, Any] | None = None,
) -> dict[str, Any]:
    ctx: dict[str, Any] = {}
    if estimated_cost is not None:
        ctx["estimated_cost"] = estimated_cost
    if skill_name is not None:
        ctx["skill_name"] = skill_name
    if extra_context:
        ctx.update(extra_context)
    return {
        "id": approval_id,
        "tool_name": tool_name,
        "risk_class": risk_class,
        "context": ctx,
        "tool_args": tool_args if tool_args is not None else {"foo": "bar"},
        "ekko_session_id": "sess-1",
    }


@pytest.fixture
def env_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the Slack post path enabled with realistic values."""
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test-token")
    monkeypatch.setenv("SLACK_APPROVAL_CHANNEL_ID", "C0B43582YJF")
    monkeypatch.setenv("DASHBOARD_BASE_URL", "https://dashboard.voxhorizon.com")


@pytest.fixture
def patch_push(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Replace ``fanout_push`` with a recorder. Tests can inspect ``state``."""
    state: dict[str, Any] = {"calls": [], "result": (1, 0), "raise": None}

    async def _fake(payload: Any) -> tuple[int, int]:
        if state["raise"] is not None:
            raise state["raise"]
        state["calls"].append(payload)
        return state["result"]

    monkeypatch.setattr(notif, "fanout_push", _fake)
    return state


@pytest.fixture
def patch_http(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Replace ``httpx.AsyncClient`` with a recorder.

    State knobs:
      * ``status`` — HTTP status code returned by the fake POST.
      * ``raise`` — exception (httpx or otherwise) to raise from ``post``.
      * ``body`` — JSON-serializable dict returned in the response body;
        defaults to ``{"ok": True, "ts": "1234567890.000100"}`` to mirror
        a normal Slack chat.postMessage success.
    """
    state: dict[str, Any] = {
        "calls": [],
        "status": 200,
        "raise": None,
        "body": {"ok": True, "ts": "1234567890.000100"},
    }

    class _FakeResponse:
        def __init__(self, body: Any) -> None:
            self.status_code = state["status"]
            self._body = body
            # Mirror httpx.Response.content (bytes). Empty bytes means the
            # service returned a body-less response (Slack never does, but
            # we test the defensive path).
            if body is None:
                self.content = b""
            else:
                try:
                    self.content = json.dumps(body).encode("utf-8")
                except (TypeError, ValueError):
                    self.content = b""

        def json(self) -> Any:
            if isinstance(self._body, Exception):
                raise self._body
            return self._body

    class _FakeClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            state["client_kwargs"] = kwargs

        async def __aenter__(self) -> "_FakeClient":
            return self

        async def __aexit__(self, *_exc: Any) -> None:
            return None

        async def post(
            self,
            url: str,
            *,
            headers: dict[str, str] | None = None,
            json: dict[str, Any] | None = None,
        ) -> _FakeResponse:
            state["calls"].append({"url": url, "headers": headers, "json": json})
            if state["raise"] is not None:
                raise state["raise"]
            return _FakeResponse(state["body"])

    monkeypatch.setattr(notif.httpx, "AsyncClient", _FakeClient)
    return state


# ---------------------------------------------------------------------------
# is_high_urgency truth table — UNCHANGED from PR #274
# ---------------------------------------------------------------------------


def test_is_high_urgency_external_write_risk_is_true() -> None:
    assert is_high_urgency({"risk_class": "external-write"}) is True


def test_is_high_urgency_low_cost_low_risk_is_false() -> None:
    assert is_high_urgency({"risk_class": "filesystem", "context": {"estimated_cost": 10}}) is False


def test_is_high_urgency_cost_just_above_threshold_is_true() -> None:
    assert is_high_urgency({"context": {"estimated_cost": 50.01}}) is True


def test_is_high_urgency_cost_equal_to_threshold_is_false() -> None:
    """$50 is the boundary — strict greater-than so the operator's floor
    is exactly $50.01."""
    assert is_high_urgency({"context": {"estimated_cost": HIGH_URGENCY_COST_THRESHOLD}}) is False


def test_is_high_urgency_no_cost_is_false() -> None:
    assert is_high_urgency({"risk_class": "filesystem", "context": {}}) is False


def test_is_high_urgency_no_context_is_false() -> None:
    assert is_high_urgency({"risk_class": "filesystem"}) is False


def test_is_high_urgency_context_not_dict_is_false() -> None:
    assert is_high_urgency({"context": "not-a-dict"}) is False


def test_is_high_urgency_cost_is_string_numeric_is_true() -> None:
    assert is_high_urgency({"context": {"estimated_cost": "75"}}) is True


def test_is_high_urgency_cost_unparseable_is_false() -> None:
    assert is_high_urgency({"context": {"estimated_cost": "not-a-number"}}) is False


def test_is_high_urgency_cost_none_is_false() -> None:
    assert is_high_urgency({"context": {"estimated_cost": None}}) is False


def test_is_high_urgency_risk_class_not_string_is_false() -> None:
    """A weird non-string risk_class should not crash, just fall through."""
    assert is_high_urgency({"risk_class": 42}) is False


# ---------------------------------------------------------------------------
# fan_out — push branch
# ---------------------------------------------------------------------------


def test_fan_out_always_pushes(
    patch_push: dict[str, Any], env_configured: None
) -> None:
    """Even a low-urgency row triggers VAPID push."""
    asyncio.run(fan_out(_row(estimated_cost=5.0, risk_class="filesystem")))
    assert len(patch_push["calls"]) == 1
    payload = patch_push["calls"][0]
    assert isinstance(payload, PushPayload)
    assert payload.kind == APPROVAL_PUSH_KIND


def test_fan_out_push_payload_shape(
    patch_push: dict[str, Any], env_configured: None
) -> None:
    asyncio.run(
        fan_out(
            _row(
                tool_name="MetaAds.create_campaign",
                risk_class="external-write",
                skill_name="campaigns",
            )
        )
    )
    payload = patch_push["calls"][0]
    assert payload.title == "Approval needed: MetaAds.create_campaign"
    assert "external-write" in payload.body
    assert "campaigns" in payload.body
    assert payload.url == "/approvals/ap-1"
    assert payload.kind == APPROVAL_PUSH_KIND


def test_fan_out_push_payload_fallbacks_when_fields_missing(
    patch_push: dict[str, Any], env_configured: None
) -> None:
    """No id / no skill / no risk → still a valid payload."""
    asyncio.run(
        fan_out(
            {
                "tool_name": None,
                "risk_class": None,
                "context": None,
                "tool_args": {},
            }
        )
    )
    payload = patch_push["calls"][0]
    assert payload.title == "Approval needed: tool"
    assert payload.url == "/approvals"
    assert payload.body == "review"


# ---------------------------------------------------------------------------
# fan_out — Slack branch (high-urgency)
# ---------------------------------------------------------------------------


def test_fan_out_high_urgency_external_write_posts_slack(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert len(patch_http["calls"]) == 1
    call = patch_http["calls"][0]
    assert call["url"] == SLACK_API_URL
    assert call["headers"]["Authorization"] == "Bearer xoxb-test-token"
    assert "application/json" in call["headers"]["Content-Type"]
    body = call["json"]
    assert body["channel"] == "C0B43582YJF"
    assert "MetaAds.update_ad" in body["text"]
    assert isinstance(body["blocks"], list)
    # The header is the first block, plain_text, includes the tool name.
    header = body["blocks"][0]
    assert header["type"] == "header"
    assert "MetaAds.update_ad" in header["text"]["text"]


def test_fan_out_high_urgency_cost_posts_slack(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    asyncio.run(fan_out(_row(estimated_cost=51.0, risk_class="filesystem")))
    assert len(patch_http["calls"]) == 1
    body = patch_http["calls"][0]["json"]
    # Cost shows up in the fallback text.
    assert "$51" in body["text"]
    # And in one of the blocks.
    cost_block_texts = [
        b["text"]["text"]
        for b in body["blocks"]
        if b.get("type") == "section" and "$51" in b.get("text", {}).get("text", "")
    ]
    assert cost_block_texts, "expected a section block carrying the formatted cost"


def test_fan_out_low_urgency_skips_slack(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    asyncio.run(fan_out(_row(estimated_cost=10.0, risk_class="filesystem")))
    assert patch_http["calls"] == []
    # Push still fired.
    assert len(patch_push["calls"]) == 1


# ---------------------------------------------------------------------------
# fan_out — failure resilience
# ---------------------------------------------------------------------------


def test_fan_out_push_failure_does_not_block_slack(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    """Push raises; Slack branch still runs."""
    patch_push["raise"] = RuntimeError("push down")
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert len(patch_http["calls"]) == 1


def test_fan_out_slack_failure_logged(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    """Slack returns {ok:false, error:'channel_not_found'} — no raise."""
    patch_http["body"] = {"ok": False, "error": "channel_not_found"}
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert len(patch_http["calls"]) == 1


def test_fan_out_slack_exception_logged(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    """httpx.ConnectError from the client is caught and logged."""
    patch_http["raise"] = httpx.ConnectError("network down")
    asyncio.run(fan_out(_row(risk_class="external-write")))


def test_fan_out_slack_unexpected_exception_swallowed(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    """A non-HTTPError from the client is still caught at the broad handler."""
    patch_http["raise"] = RuntimeError("totally unexpected")
    asyncio.run(fan_out(_row(risk_class="external-write")))


def test_fan_out_slack_missing_token_skipped(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)
    monkeypatch.setenv("SLACK_APPROVAL_CHANNEL_ID", "C0B43582YJF")
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert patch_http["calls"] == []
    # Push still ran though.
    assert len(patch_push["calls"]) == 1


def test_fan_out_slack_missing_channel_skipped(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.delenv("SLACK_APPROVAL_CHANNEL_ID", raising=False)
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert patch_http["calls"] == []


def test_fan_out_slack_skipped_when_env_blank(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Whitespace-only env values count as unset."""
    monkeypatch.setenv("SLACK_BOT_TOKEN", "   ")
    monkeypatch.setenv("SLACK_APPROVAL_CHANNEL_ID", "   ")
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert patch_http["calls"] == []


def test_fan_out_slack_handles_unparseable_body(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    """A non-JSON Slack response logs the failure but does not raise."""

    # The fake response.json() raises ValueError. The module should catch
    # it, treat the result as a logical failure, and return cleanly.
    patch_http["body"] = ValueError("not json")
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert len(patch_http["calls"]) == 1


def test_fan_out_slack_handles_body_present_but_invalid_json(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Response has content but `.json()` raises — defensive fallback path."""

    # Build a fake response whose `.content` is non-empty AND whose
    # `.json()` raises ValueError. The module should treat this as a
    # failure response and never raise.
    class _BrokenJSONResponse:
        status_code = 200
        content = b"this is not json"

        def json(self) -> Any:
            raise ValueError("simulated json parse error")

    class _Client:
        def __init__(self, *a: Any, **kw: Any) -> None:
            pass

        async def __aenter__(self) -> "_Client":
            return self

        async def __aexit__(self, *_exc: Any) -> None:
            return None

        async def post(self, *a: Any, **kw: Any) -> _BrokenJSONResponse:
            patch_http["calls"].append({"url": a[0], "headers": kw.get("headers"), "json": kw.get("json")})
            return _BrokenJSONResponse()

    monkeypatch.setattr(notif.httpx, "AsyncClient", _Client)
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert len(patch_http["calls"]) == 1


def test_fan_out_slack_handles_non_dict_json(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    """If Slack returns a non-dict JSON (impossible in prod, defensive)."""
    patch_http["body"] = ["not", "a", "dict"]
    asyncio.run(fan_out(_row(risk_class="external-write")))


# ---------------------------------------------------------------------------
# fan_out — never raises (defensive smoke)
# ---------------------------------------------------------------------------


def test_fan_out_never_raises_on_empty_row(
    patch_push: dict[str, Any], env_configured: None
) -> None:
    """An empty row dict shouldn't blow up the worker."""
    asyncio.run(fan_out({}))
    # Push still attempted with default payload.
    assert len(patch_push["calls"]) == 1


# ---------------------------------------------------------------------------
# Block Kit / sanitization unit tests
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "args,expected_redacted_keys",
    [
        ({"api_key": "AKIA-XXXX", "user": "ekko"}, ["api_key"]),
        ({"apikey": "abc"}, ["apikey"]),
        ({"api-key": "abc"}, ["api-key"]),
        ({"password": "hunter2", "username": "diogo"}, ["password"]),
        ({"secret": "shhh", "label": "ok"}, ["secret"]),
        ({"bot_token": "xoxb", "channel": "C123"}, ["bot_token"]),
        (
            {
                "outer": {
                    "inner": {
                        "access_token": "leak",
                        "ok": "safe",
                    }
                }
            },
            ["access_token"],
        ),
        (
            {
                "things": [
                    {"refresh_token": "r"},
                    {"name": "fine"},
                ]
            },
            ["refresh_token"],
        ),
    ],
)
def test_sanitize_args_redacts_tokens(
    args: dict[str, Any], expected_redacted_keys: list[str]
) -> None:
    sanitized = notif._sanitize_args(args)
    serialized = json.dumps(sanitized)
    for key in expected_redacted_keys:
        # The key itself is preserved; the VALUE under it must be the marker.
        assert f'"{key}": "<redacted>"' in serialized, serialized
    # The original args dict must NOT be mutated.
    assert "<redacted>" not in json.dumps(args)


def test_sanitize_args_passes_through_scalars() -> None:
    assert notif._sanitize_args(42) == 42
    assert notif._sanitize_args("hello") == "hello"
    assert notif._sanitize_args(None) is None


def test_sanitize_args_preserves_non_sensitive_keys() -> None:
    args = {"name": "diogo", "count": 3, "nested": {"label": "ok"}}
    sanitized = notif._sanitize_args(args)
    assert sanitized == args


def test_blocks_truncate_long_args() -> None:
    """5000-char tool_args produces a block whose code-fenced text stays
    within the 600-char preview budget + a small wrapper allowance."""
    huge = {"data": "x" * 5000}
    row = _row(risk_class="external-write", tool_args=huge)
    blocks = notif._build_blocks(row)
    code_blocks = [
        b
        for b in blocks
        if b.get("type") == "section"
        and b.get("text", {}).get("text", "").startswith("```")
    ]
    assert code_blocks, "expected a code-fenced section for the args preview"
    text = code_blocks[0]["text"]["text"]
    # 600 char budget + the literal '...' tail + the surrounding ``` fences.
    # _MAX_ARGS_PREVIEW_CHARS=600, plus '...' (3) plus '```' x 2 (6) = 609.
    assert len(text) <= 620
    assert text.endswith("```")
    assert "..." in text


def test_blocks_include_dashboard_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DASHBOARD_BASE_URL", "https://staging.voxhorizon.com")
    blocks = notif._build_blocks(_row(approval_id="ap-42", risk_class="external-write"))
    action_blocks = [b for b in blocks if b.get("type") == "actions"]
    assert action_blocks, "expected an actions block with the CTA button"
    elements = action_blocks[0]["elements"]
    assert len(elements) == 1
    button = elements[0]
    assert button["type"] == "button"
    assert button["text"]["text"] == "Open in dashboard"
    assert button["style"] == "primary"
    assert button["url"] == "https://staging.voxhorizon.com/approvals/ap-42"


def test_blocks_dashboard_url_uses_default_when_env_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DASHBOARD_BASE_URL", raising=False)
    blocks = notif._build_blocks(_row(approval_id="ap-99", risk_class="external-write"))
    action_blocks = [b for b in blocks if b.get("type") == "actions"]
    button = action_blocks[0]["elements"][0]
    assert button["url"] == "https://dashboard.voxhorizon.com/approvals/ap-99"


def test_blocks_dashboard_url_handles_empty_approval_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DASHBOARD_BASE_URL", raising=False)
    blocks = notif._build_blocks({"id": "", "tool_name": "t", "risk_class": "external-write"})
    action_blocks = [b for b in blocks if b.get("type") == "actions"]
    button = action_blocks[0]["elements"][0]
    assert button["url"].endswith("/approvals")


def test_blocks_dashboard_url_strips_trailing_slash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DASHBOARD_BASE_URL", "https://x.example.com/")
    blocks = notif._build_blocks(_row(approval_id="ap-7", risk_class="external-write"))
    action_blocks = [b for b in blocks if b.get("type") == "actions"]
    button = action_blocks[0]["elements"][0]
    assert button["url"] == "https://x.example.com/approvals/ap-7"


def test_blocks_external_write_uses_warning_icon() -> None:
    blocks = notif._build_blocks(_row(risk_class="external-write"))
    header = blocks[0]
    assert header["type"] == "header"
    # The warning sign is the leading char.
    assert header["text"]["text"].startswith("⚠")


def test_blocks_cost_driven_uses_money_icon() -> None:
    blocks = notif._build_blocks(_row(risk_class="filesystem", estimated_cost=75.0))
    header = blocks[0]
    # The money-bag emoji 💰 is U+1F4B0.
    assert header["text"]["text"].startswith("\U0001f4b0")


def test_blocks_context_includes_known_fields() -> None:
    row = _row(
        risk_class="external-write",
        extra_context={
            "pipeline_id": "pl-1",
            "brief_id_human": "VOX-2026-0001",
            "creative_id": "cr-9",
        },
    )
    blocks = notif._build_blocks(row)
    section_texts = [
        b["text"]["text"]
        for b in blocks
        if b.get("type") == "section"
    ]
    joined = "\n".join(section_texts)
    assert "pl-1" in joined
    assert "VOX-2026-0001" in joined
    assert "cr-9" in joined
    # Skill name from the default _row helper:
    assert "marketing-control" in joined


def test_blocks_skip_context_block_when_no_fields() -> None:
    """Row with only risk_class produces a block stack without the context
    section (no fields to fill it)."""
    row = {
        "id": "ap-z",
        "tool_name": "X",
        "risk_class": "external-write",
        "context": {},
        "tool_args": {},
    }
    blocks = notif._build_blocks(row)
    # No section block carries Pipeline / Brief / Creative / Skill / Session
    # — but we DO carry "Risk:" because risk_class itself is a useful signal.
    section_texts = [
        b["text"]["text"]
        for b in blocks
        if b.get("type") == "section"
    ]
    assert any("Risk:" in t for t in section_texts)


def test_blocks_high_spend_decorates_cost() -> None:
    row = _row(risk_class="filesystem", estimated_cost=250.0)
    blocks = notif._build_blocks(row)
    section_texts = [
        b["text"]["text"]
        for b in blocks
        if b.get("type") == "section"
    ]
    high_blocks = [t for t in section_texts if "HIGH SPEND" in t]
    assert high_blocks, "expected an alarm-decorated cost block above $100"
    assert "\U0001f6a8" in high_blocks[0]  # 🚨


def test_blocks_cost_unparseable_skipped() -> None:
    """If cost cannot be coerced to float, no cost block emitted."""
    row = _row(risk_class="external-write")
    row["context"]["estimated_cost"] = "not-a-number"
    blocks = notif._build_blocks(row)
    section_texts = "\n".join(
        b["text"]["text"]
        for b in blocks
        if b.get("type") == "section"
    )
    assert "Estimated cost" not in section_texts
    assert "HIGH SPEND" not in section_texts


def test_blocks_args_sanitized_in_message(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    """End-to-end: sensitive keys in tool_args don't leak into the Slack body."""
    row = _row(
        risk_class="external-write",
        tool_args={"api_key": "SECRET-VALUE-HERE", "tool_input": "ok"},
    )
    asyncio.run(fan_out(row))
    body = patch_http["calls"][0]["json"]
    serialized = json.dumps(body)
    assert "SECRET-VALUE-HERE" not in serialized
    assert "<redacted>" in serialized


def test_blocks_args_preview_handles_non_serializable() -> None:
    class _NonSerializable:
        def __str__(self) -> str:
            return "<custom>"

    row = _row(risk_class="external-write", tool_args={"x": _NonSerializable()})
    blocks = notif._build_blocks(row)
    code_block_texts = [
        b["text"]["text"]
        for b in blocks
        if b.get("type") == "section"
        and b.get("text", {}).get("text", "").startswith("```")
    ]
    assert code_block_texts
    # default=str fallback kicks in, surfacing our marker.
    assert "<custom>" in code_block_texts[0]


def test_blocks_args_preview_handles_circular() -> None:
    """Circular dicts force the sanitize cycle-break, which then serializes."""
    circular: dict[str, Any] = {}
    circular["self"] = circular
    row = _row(risk_class="external-write", tool_args=circular)
    blocks = notif._build_blocks(row)
    code_block_texts = [
        b["text"]["text"]
        for b in blocks
        if b.get("type") == "section"
        and b.get("text", {}).get("text", "").startswith("```")
    ]
    assert code_block_texts  # at least produces SOMETHING
    # The cycle was broken with our literal marker.
    assert "<circular>" in code_block_texts[0]


def test_blocks_args_preview_falls_back_to_repr_when_dumps_raises() -> None:
    """Non-str/int/float/bool/None keys force json.dumps to raise even with
    default=str — the builder must fall back to repr rather than crash."""
    # Tuple key — json forbids these and default= only kicks in for VALUES.
    row = _row(risk_class="external-write", tool_args={(1, 2): "x"})
    blocks = notif._build_blocks(row)
    code_block_texts = [
        b["text"]["text"]
        for b in blocks
        if b.get("type") == "section"
        and b.get("text", {}).get("text", "").startswith("```")
    ]
    assert code_block_texts  # produced via repr fallback


def test_blocks_header_truncated_for_long_tool_name() -> None:
    long_tool_name = "X" * 200
    row = _row(risk_class="external-write", tool_name=long_tool_name)
    blocks = notif._build_blocks(row)
    header = blocks[0]
    assert len(header["text"]["text"]) <= 150


def test_blocks_handle_non_dict_context() -> None:
    """When context is a non-dict (e.g. a string) the builder must not crash."""
    row = {
        "id": "ap-1",
        "tool_name": "X",
        "risk_class": "external-write",
        "context": "i am a string not a dict",
        "tool_args": {},
    }
    blocks = notif._build_blocks(row)
    # Header + args + actions at minimum. The context-section may be empty
    # (no fields to render), but the call must complete.
    types = [b["type"] for b in blocks]
    assert "header" in types
    assert "actions" in types


# ---------------------------------------------------------------------------
# Text fallback
# ---------------------------------------------------------------------------


def test_text_fallback_carries_tool_name_and_cost() -> None:
    text = notif._build_text_fallback(
        _row(tool_name="K.shipit", risk_class="external-write", estimated_cost=75.25)
    )
    assert "K.shipit" in text
    assert "external-write" in text
    assert "$75.25" in text


def test_text_fallback_handles_missing_cost() -> None:
    text = notif._build_text_fallback(
        {"tool_name": "X", "risk_class": "external-write", "context": {}, "tool_args": {}}
    )
    assert "X" in text


def test_text_fallback_handles_garbage_cost() -> None:
    text = notif._build_text_fallback(
        {
            "tool_name": "X",
            "risk_class": None,
            "context": {"estimated_cost": "not-a-number"},
        }
    )
    # Should still render the tool name even when cost is unparseable.
    assert "X" in text
