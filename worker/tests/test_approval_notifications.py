"""Tests for the HI-17 approval notifications fan-out helper.

The module is small but every branch matters because it's fire-and-forget —
a regression here is silent (no error surfaces to the operator). We cover:

* :func:`is_high_urgency` truth table (risk class, cost edges, garbage in)
* Push fan-out always fires (low-urgency stays inside the push branch)
* Email fan-out only fires for high-urgency rows
* External-write risk → email
* Cost > $50 → email
* Cost == $50 → no email (strict greater-than)
* Cost is None → no email
* Missing env config → email skipped, push still runs
* Push failure does NOT skip the email step (independent branches)
* Email failure (non-2xx, network error) logs but never raises
* HTTP timeout / arbitrary exception path
* Argument serialization: long preview is truncated, JSON-incompatible
  inputs fall back to ``repr``
* Push payload shape: title / body / url / kind line up with the SW contract
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
    monkeypatch.setenv("INTERNAL_API_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_API_TOKEN", "internal-test-token")


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
    """Replace ``httpx.AsyncClient`` with a recorder."""
    state: dict[str, Any] = {
        "calls": [],
        "status": 200,
        "raise": None,
        "body": "ok",
    }

    class _FakeResponse:
        def __init__(self) -> None:
            self.status_code = state["status"]
            self.text = state["body"]

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
            return _FakeResponse()

    monkeypatch.setattr(notif.httpx, "AsyncClient", _FakeClient)
    return state


# ---------------------------------------------------------------------------
# is_high_urgency truth table
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
# fan_out — email branch (high-urgency)
# ---------------------------------------------------------------------------


def test_fan_out_high_urgency_external_write_sends_email(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert len(patch_http["calls"]) == 1
    call = patch_http["calls"][0]
    assert call["url"] == "http://web:3000/api/internal/approval-email"
    assert call["headers"]["Authorization"] == "Bearer internal-test-token"
    assert call["json"]["approval_id"] == "ap-1"
    assert call["json"]["tool_name"] == "MetaAds.update_ad"
    assert call["json"]["risk_class"] == "external-write"


def test_fan_out_high_urgency_cost_sends_email(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    asyncio.run(fan_out(_row(estimated_cost=51.0, risk_class="filesystem")))
    assert len(patch_http["calls"]) == 1
    assert patch_http["calls"][0]["json"]["estimated_cost"] == 51.0


def test_fan_out_low_urgency_skips_email(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    asyncio.run(fan_out(_row(estimated_cost=10.0, risk_class="filesystem")))
    assert patch_http["calls"] == []
    # Push still fired.
    assert len(patch_push["calls"]) == 1


def test_fan_out_email_payload_includes_context_summary(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    row = _row(
        risk_class="external-write",
        extra_context={
            "pipeline_name": "Image v1",
            "brief_id_human": "VOX-2026-0001",
        },
    )
    asyncio.run(fan_out(row))
    payload = patch_http["calls"][0]["json"]
    summary = payload["context_summary"]
    assert summary["pipeline_name"] == "Image v1"
    assert summary["brief_id_human"] == "VOX-2026-0001"
    assert summary["skill_name"] == "marketing-control"
    assert summary["session_id"] == "sess-1"


def test_fan_out_email_args_preview_is_truncated(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    big = {"data": "x" * 5000}
    asyncio.run(
        fan_out(_row(risk_class="external-write", tool_args=big))
    )
    preview = patch_http["calls"][0]["json"]["tool_args_preview"]
    # Truncation marker present and length is bounded.
    assert preview.endswith("...")
    assert len(preview) <= 503  # 500 + "..."


def test_fan_out_email_args_preview_handles_non_json_serializable(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    """A non-serializable tool_args still produces a non-empty preview."""

    class _NonSerializable:
        def __str__(self) -> str:
            return "<custom>"

    row = _row(risk_class="external-write", tool_args={"x": _NonSerializable()})
    asyncio.run(fan_out(row))
    preview = patch_http["calls"][0]["json"]["tool_args_preview"]
    assert preview  # not empty
    # The default=str fallback turns the object into a string in the JSON,
    # so the preview should mention our marker.
    assert "<custom>" in preview


# ---------------------------------------------------------------------------
# fan_out — failure resilience
# ---------------------------------------------------------------------------


def test_fan_out_push_failure_does_not_block_email(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    """Push raises; email branch still runs."""
    patch_push["raise"] = RuntimeError("push down")
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert len(patch_http["calls"]) == 1


def test_fan_out_email_non_2xx_logs_but_does_not_raise(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    patch_http["status"] = 502
    patch_http["body"] = "upstream error"
    # Must not raise.
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert len(patch_http["calls"]) == 1


def test_fan_out_email_http_error_swallowed(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    patch_http["raise"] = httpx.ConnectError("network down")
    asyncio.run(fan_out(_row(risk_class="external-write")))


def test_fan_out_email_unexpected_exception_swallowed(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    """A non-HTTPError from the client is still caught at the broad handler."""
    patch_http["raise"] = RuntimeError("totally unexpected")
    asyncio.run(fan_out(_row(risk_class="external-write")))


def test_fan_out_email_skipped_when_url_missing(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("INTERNAL_API_BASE_URL", raising=False)
    monkeypatch.setenv("INTERNAL_API_TOKEN", "tok")
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert patch_http["calls"] == []
    # Push still ran though.
    assert len(patch_push["calls"]) == 1


def test_fan_out_email_skipped_when_token_missing(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("INTERNAL_API_BASE_URL", "http://web:3000")
    monkeypatch.delenv("INTERNAL_API_TOKEN", raising=False)
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert patch_http["calls"] == []


def test_fan_out_email_skipped_when_env_blank(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Whitespace-only env values count as unset."""
    monkeypatch.setenv("INTERNAL_API_BASE_URL", "   ")
    monkeypatch.setenv("INTERNAL_API_TOKEN", "   ")
    asyncio.run(fan_out(_row(risk_class="external-write")))
    assert patch_http["calls"] == []


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


def test_fan_out_strips_blank_context_summary_keys(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    row = _row(
        risk_class="external-write",
        extra_context={"pipeline_name": "", "brief_id_human": "VOX-1"},
    )
    asyncio.run(fan_out(row))
    summary = patch_http["calls"][0]["json"]["context_summary"]
    assert "pipeline_name" not in summary  # empty string dropped
    assert summary["brief_id_human"] == "VOX-1"


def test_fan_out_email_payload_cost_unparseable_becomes_none(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    """If context.estimated_cost is garbage we still send email when the
    risk class is high — and the payload's estimated_cost is None."""
    row = _row(risk_class="external-write")
    # Make cost unparseable AFTER classification has used the risk path.
    row["context"]["estimated_cost"] = "not-a-number"
    asyncio.run(fan_out(row))
    assert patch_http["calls"][0]["json"]["estimated_cost"] is None


def test_fan_out_email_payload_json_dumps_fallback_to_repr(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When json.dumps itself raises (even with default=str), fall back to repr."""

    real_dumps = json.dumps

    def _failing_dumps(*args: Any, **kwargs: Any) -> str:
        raise TypeError("simulated dumps failure")

    monkeypatch.setattr(notif.__dict__["json"] if "json" in notif.__dict__ else json, "dumps", _failing_dumps)

    # If notif uses a local `import json` we have to patch it via the helper's
    # namespace. Easier: build a manual case using a value json refuses
    # and that also breaks default=str — by exhausting the recursion
    # via a self-referential structure.
    monkeypatch.setattr(json, "dumps", real_dumps)  # restore

    # Use a circular dict — json.dumps raises ValueError on circular refs.
    circular: dict[str, Any] = {}
    circular["self"] = circular
    row = _row(risk_class="external-write", tool_args=circular)
    asyncio.run(fan_out(row))
    preview = patch_http["calls"][0]["json"]["tool_args_preview"]
    # repr of a circular dict still produces a valid string.
    assert preview  # non-empty


def test_fan_out_email_payload_handles_non_dict_context(
    patch_push: dict[str, Any],
    patch_http: dict[str, Any],
    env_configured: None,
) -> None:
    """When context is a non-dict and risk forces high-urgency, the
    summary is empty and cost is None — no crash."""
    row = {
        "id": "ap-1",
        "tool_name": "X",
        "risk_class": "external-write",
        "context": "i am a string not a dict",
        "tool_args": {},
    }
    asyncio.run(fan_out(row))
    assert len(patch_http["calls"]) == 1
    payload = patch_http["calls"][0]["json"]
    assert payload["context_summary"] == {}
    assert payload["estimated_cost"] is None
