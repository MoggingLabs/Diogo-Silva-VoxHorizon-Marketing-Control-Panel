"""Unit tests for dashboard-publish helper.

httpx is mocked via its MockTransport so we exercise the real httpx.Client
code path without hitting Supabase. Each test asserts the request body
(table, JSON payload, headers) as well as the helper's return value or
the error raised.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest

# Make ``helper`` importable when running ``pytest tests/`` from inside the
# skill directory or from the repo root.
HERE = Path(__file__).resolve().parent
SKILL_DIR = HERE.parent
sys.path.insert(0, str(SKILL_DIR))

import helper  # noqa: E402  — must follow sys.path insertion
from helper import (  # noqa: E402
    DashboardPublishError,
    publish_audit_row,
    publish_brief,
    publish_creative,
    publish_pipeline_event,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

GOOD_URL = "https://example.supabase.co"
GOOD_KEY = "service-role-key-xyz"


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set valid env vars by default; individual tests override as needed."""
    monkeypatch.setenv("SUPABASE_URL", GOOD_URL)
    monkeypatch.setenv("SUPABASE_SECRET_KEY", GOOD_KEY)


def _install_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> list[httpx.Request]:
    """Patch ``helper._client`` to use httpx.MockTransport.

    Returns a list that captures every request handed to the transport so
    tests can assert on URL, body, and headers.
    """
    captured: list[httpx.Request] = []

    def _wrapped(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    original_client = helper._client

    def _patched_client() -> httpx.Client:
        # Call the original to validate env-var handling, then swap the
        # transport so no real HTTP fires.
        c = original_client()
        c._transport = httpx.MockTransport(_wrapped)
        return c

    monkeypatch.setattr(helper, "_client", _patched_client)
    return captured


def _ok(row: dict[str, Any]) -> Callable[[httpx.Request], httpx.Response]:
    """Build a handler that returns 201 with a single-row array body."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json=[row])

    return handler


# ---------------------------------------------------------------------------
# Missing-env-var path (covers every public function)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "missing_var", ["SUPABASE_URL", "SUPABASE_SECRET_KEY"]
)
@pytest.mark.parametrize(
    "call",
    [
        lambda: publish_brief(
            client_slug="x", payload={"service": "roofing", "budget": 50}
        ),
        lambda: publish_creative(
            brief_id="b",
            concept="c",
            ratio="1x1",
            file_path_supabase="p",
            prompt_used={},
        ),
        lambda: publish_audit_row(
            client_id="c",
            campaign_id="123",
            window_days=7,
            metrics={"spend": 1},
            verdict="keep",
        ),
        lambda: publish_pipeline_event(pipeline_id="p", kind="x"),
    ],
)
def test_missing_env_raises(
    monkeypatch: pytest.MonkeyPatch,
    missing_var: str,
    call: Callable[[], dict[str, Any]],
) -> None:
    monkeypatch.delenv(missing_var, raising=False)
    with pytest.raises(DashboardPublishError, match="not set"):
        call()


def test_empty_env_treated_as_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "")
    with pytest.raises(DashboardPublishError, match="not set"):
        publish_pipeline_event(pipeline_id="p", kind="x")


# ---------------------------------------------------------------------------
# publish_brief
# ---------------------------------------------------------------------------


def test_publish_brief_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    inserted = {
        "id": "00000000-0000-0000-0000-000000000001",
        "status": "posted",
        "payload": {
            "service": "roofing",
            "budget": 50,
            "client_slug": "dinerohomes",
        },
        "brief_id_human": "dinerohomes-2026-05-17-001",
    }
    captured = _install_transport(monkeypatch, _ok(inserted))

    row = publish_brief(
        client_slug="dinerohomes",
        payload={"service": "roofing", "budget": 50, "market": "Austin"},
        status="posted",
        brief_id_human="dinerohomes-2026-05-17-001",
    )

    assert row == inserted
    assert len(captured) == 1
    req = captured[0]
    assert req.method == "POST"
    assert req.url.path == "/rest/v1/briefs"
    body = json.loads(req.content)
    assert body["status"] == "posted"
    assert body["brief_id_human"] == "dinerohomes-2026-05-17-001"
    # client_slug is mirrored onto payload so consumers can read it raw.
    assert body["payload"]["client_slug"] == "dinerohomes"
    assert body["payload"]["service"] == "roofing"
    assert body["payload"]["budget"] == 50
    assert body["payload"]["market"] == "Austin"
    # Service-role headers must be set.
    assert req.headers["apikey"] == GOOD_KEY
    assert req.headers["Authorization"] == f"Bearer {GOOD_KEY}"
    assert req.headers["Prefer"] == "return=representation"


def test_publish_brief_with_explicit_id(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _install_transport(
        monkeypatch, _ok({"id": "11111111-1111-1111-1111-111111111111"})
    )
    publish_brief(
        client_slug="x",
        payload={"service": "roofing", "budget": 1},
        brief_id="11111111-1111-1111-1111-111111111111",
    )
    body = json.loads(captured[0].content)
    assert body["id"] == "11111111-1111-1111-1111-111111111111"


def test_publish_brief_validates_payload_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Even though no HTTP fires, install a transport so a programming bug
    # that lets it through would not silently hit Supabase.
    handler_called = [False]

    def handler(_req: httpx.Request) -> httpx.Response:
        handler_called[0] = True
        return httpx.Response(201, json=[{}])

    _install_transport(monkeypatch, handler)

    with pytest.raises(DashboardPublishError, match="service.*budget"):
        publish_brief(
            client_slug="x", payload={"service": "roofing"}
        )  # missing budget
    with pytest.raises(DashboardPublishError, match="service.*budget"):
        publish_brief(client_slug="x", payload={"budget": 50})  # missing service
    assert handler_called[0] is False


def test_publish_brief_rejects_non_dict_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_transport(monkeypatch, _ok({}))
    with pytest.raises(DashboardPublishError, match="must be a dict"):
        publish_brief(client_slug="x", payload="not-a-dict")  # type: ignore[arg-type]


def test_publish_brief_4xx_includes_response_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400, json={"code": "PGRST116", "message": "bad enum value"}
        )

    _install_transport(monkeypatch, handler)
    with pytest.raises(DashboardPublishError) as exc:
        publish_brief(
            client_slug="x", payload={"service": "roofing", "budget": 1}
        )
    assert "400" in str(exc.value)
    assert "PGRST116" in str(exc.value)


def test_publish_brief_5xx_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="upstream unavailable")

    _install_transport(monkeypatch, handler)
    with pytest.raises(DashboardPublishError) as exc:
        publish_brief(
            client_slug="x", payload={"service": "roofing", "budget": 1}
        )
    assert "503" in str(exc.value)
    assert "upstream" in str(exc.value)


def test_publish_brief_network_error_wrapped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    _install_transport(monkeypatch, handler)
    with pytest.raises(DashboardPublishError, match="network error"):
        publish_brief(
            client_slug="x", payload={"service": "roofing", "budget": 1}
        )


def test_publish_brief_empty_array_response_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json=[])

    _install_transport(monkeypatch, handler)
    with pytest.raises(DashboardPublishError, match="empty body"):
        publish_brief(
            client_slug="x", payload={"service": "roofing", "budget": 1}
        )


def test_publish_brief_non_json_response_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(201, text="<html>oops</html>")

    _install_transport(monkeypatch, handler)
    with pytest.raises(DashboardPublishError, match="non-JSON"):
        publish_brief(
            client_slug="x", payload={"service": "roofing", "budget": 1}
        )


# ---------------------------------------------------------------------------
# publish_creative
# ---------------------------------------------------------------------------


def test_publish_creative_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    inserted = {
        "id": "22222222-2222-2222-2222-222222222222",
        "brief_id": "00000000-0000-0000-0000-000000000001",
        "concept": "owner-led trust",
        "ratio": "1x1",
        "status": "draft",
        "version": "v1.0",
    }
    captured = _install_transport(monkeypatch, _ok(inserted))

    row = publish_creative(
        brief_id="00000000-0000-0000-0000-000000000001",
        concept="owner-led trust",
        ratio="1x1",
        file_path_supabase="creatives/abc.jpg",
        prompt_used={"prompt": "real iphone shot of roofer"},
        offer_text="$500 off",
    )

    assert row == inserted
    req = captured[0]
    assert req.url.path == "/rest/v1/creatives"
    body = json.loads(req.content)
    assert body == {
        "brief_id": "00000000-0000-0000-0000-000000000001",
        "concept": "owner-led trust",
        "ratio": "1x1",
        "file_path_supabase": "creatives/abc.jpg",
        "prompt_used": {"prompt": "real iphone shot of roofer"},
        "version": "v1.0",
        "status": "draft",
        "offer_text": "$500 off",
    }


def test_publish_creative_omits_offer_text_when_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _install_transport(monkeypatch, _ok({"id": "x"}))
    publish_creative(
        brief_id="b",
        concept="c",
        ratio="9x16",
        file_path_supabase="p",
        prompt_used={"k": "v"},
    )
    body = json.loads(captured[0].content)
    assert "offer_text" not in body
    assert body["version"] == "v1.0"
    assert body["status"] == "draft"


def test_publish_creative_4xx_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            422, json={"message": "invalid input value for enum ratio"}
        )

    _install_transport(monkeypatch, handler)
    with pytest.raises(DashboardPublishError) as exc:
        publish_creative(
            brief_id="b",
            concept="c",
            ratio="invalid",
            file_path_supabase="p",
            prompt_used={},
        )
    assert "422" in str(exc.value)
    assert "ratio" in str(exc.value)


def test_publish_creative_5xx_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="internal error")

    _install_transport(monkeypatch, handler)
    with pytest.raises(DashboardPublishError, match="500"):
        publish_creative(
            brief_id="b",
            concept="c",
            ratio="1x1",
            file_path_supabase="p",
            prompt_used={},
        )


# ---------------------------------------------------------------------------
# publish_audit_row
# ---------------------------------------------------------------------------


def test_publish_audit_row_image_filters_unknown_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inserted = {"id": "audit-1", "verdict": "keep"}
    captured = _install_transport(monkeypatch, _ok(inserted))

    row = publish_audit_row(
        client_id="33333333-3333-3333-3333-333333333333",
        campaign_id="meta-123",
        window_days=7,
        metrics={
            "spend": 350.55,
            "impressions": 12000,
            "clicks": 220,
            "ctr": 0.0183,
            "leads_meta": 22,
            "leads_ghl": 18,
            "cpl_real": 19.47,
            "freq": 1.4,
            # Video-only fields must be silently dropped on image side.
            "hook_rate": 0.31,
            # Genuinely unknown fields must also be dropped.
            "extra_pass_through": "should-not-appear",
        },
        verdict="keep",
        verdict_reason="cpl trending below target",
    )

    assert row == inserted
    req = captured[0]
    assert req.url.path == "/rest/v1/campaign_perf_image"
    body = json.loads(req.content)
    assert body["client_id"] == "33333333-3333-3333-3333-333333333333"
    assert body["campaign_id"] == "meta-123"
    assert body["window_days"] == 7
    assert body["verdict"] == "keep"
    assert body["verdict_reason"] == "cpl trending below target"
    assert body["spend"] == 350.55
    assert body["impressions"] == 12000
    assert body["clicks"] == 220
    assert body["leads_meta"] == 22
    assert "hook_rate" not in body
    assert "extra_pass_through" not in body


def test_publish_audit_row_video_keeps_video_metrics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _install_transport(monkeypatch, _ok({"id": "audit-2"}))

    publish_audit_row(
        client_id="c",
        campaign_id="meta-456",
        window_days=14,
        metrics={
            "spend": 100,
            "hook_rate": 0.4,
            "drop_off_3s": 0.6,
            "view_rate_avg": 0.22,
            "watch_time_p50": 4.8,
            "garbage": "drop me",
        },
        verdict="watch",
        format="video",
    )

    req = captured[0]
    assert req.url.path == "/rest/v1/campaign_perf_video"
    body = json.loads(req.content)
    assert body["hook_rate"] == 0.4
    assert body["drop_off_3s"] == 0.6
    assert body["view_rate_avg"] == 0.22
    assert body["watch_time_p50"] == 4.8
    assert body["spend"] == 100
    assert "garbage" not in body


def test_publish_audit_row_unknown_format_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_transport(monkeypatch, _ok({}))
    with pytest.raises(DashboardPublishError, match="format must be"):
        publish_audit_row(
            client_id="c",
            campaign_id="x",
            window_days=1,
            metrics={},
            verdict="keep",
            format="carousel",
        )


def test_publish_audit_row_4xx_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409, json={"message": "duplicate key value violates unique constraint"}
        )

    _install_transport(monkeypatch, handler)
    with pytest.raises(DashboardPublishError, match="409"):
        publish_audit_row(
            client_id="c",
            campaign_id="x",
            window_days=1,
            metrics={"spend": 1},
            verdict="keep",
        )


def test_publish_audit_row_5xx_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="bad gateway")

    _install_transport(monkeypatch, handler)
    with pytest.raises(DashboardPublishError, match="502"):
        publish_audit_row(
            client_id="c",
            campaign_id="x",
            window_days=1,
            metrics={"spend": 1},
            verdict="keep",
        )


# ---------------------------------------------------------------------------
# publish_pipeline_event
# ---------------------------------------------------------------------------


def test_publish_pipeline_event_happy_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inserted = {
        "id": "44444444-4444-4444-4444-444444444444",
        "pipeline_id": "55555555-5555-5555-5555-555555555555",
        "kind": "stage_advanced",
        "stage": "review",
        "source": "hermes-task",
    }
    captured = _install_transport(monkeypatch, _ok(inserted))

    row = publish_pipeline_event(
        pipeline_id="55555555-5555-5555-5555-555555555555",
        kind="stage_advanced",
        stage="review",
        payload={"actor": "hermes", "duration_s": 12},
    )

    assert row == inserted
    req = captured[0]
    assert req.url.path == "/rest/v1/pipeline_events"
    body = json.loads(req.content)
    assert body == {
        "pipeline_id": "55555555-5555-5555-5555-555555555555",
        "kind": "stage_advanced",
        "stage": "review",
        "source": "hermes-task",
        "payload": {"actor": "hermes", "duration_s": 12},
    }


def test_publish_pipeline_event_omits_optional_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _install_transport(monkeypatch, _ok({"id": "e"}))
    publish_pipeline_event(pipeline_id="p", kind="approval_recorded")
    body = json.loads(captured[0].content)
    assert body == {
        "pipeline_id": "p",
        "kind": "approval_recorded",
        "source": "hermes-task",
    }


def test_publish_pipeline_event_custom_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _install_transport(monkeypatch, _ok({"id": "e"}))
    publish_pipeline_event(
        pipeline_id="p", kind="hook_fired", source="hermes-hook"
    )
    body = json.loads(captured[0].content)
    assert body["source"] == "hermes-hook"


def test_publish_pipeline_event_4xx_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400, json={"message": "invalid input value for enum pipeline_event_source_enum"}
        )

    _install_transport(monkeypatch, handler)
    with pytest.raises(DashboardPublishError, match="400"):
        publish_pipeline_event(pipeline_id="p", kind="x", source="totally-bogus")


def test_publish_pipeline_event_5xx_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(504, text="gateway timeout")

    _install_transport(monkeypatch, handler)
    with pytest.raises(DashboardPublishError, match="504"):
        publish_pipeline_event(pipeline_id="p", kind="x")


def test_publish_pipeline_event_network_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out")

    _install_transport(monkeypatch, handler)
    with pytest.raises(DashboardPublishError, match="network error"):
        publish_pipeline_event(pipeline_id="p", kind="x")


# ---------------------------------------------------------------------------
# URL hygiene
# ---------------------------------------------------------------------------


def test_supabase_url_trailing_slash_is_stripped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SUPABASE_URL", GOOD_URL + "/")
    captured = _install_transport(monkeypatch, _ok({"id": "e"}))
    publish_pipeline_event(pipeline_id="p", kind="x")
    # base_url should not end up with a double slash before /rest/v1.
    assert str(captured[0].url) == f"{GOOD_URL}/rest/v1/pipeline_events"
