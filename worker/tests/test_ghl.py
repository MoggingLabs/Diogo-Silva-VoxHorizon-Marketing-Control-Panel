"""Tests for the GHL connector (P5.3 / #366).

No live calls: every HTTP path runs through ``httpx.MockTransport`` injected
into the connector's resilient client. ``real_cpl`` and ``parse_webhook_event``
are pure and tested directly.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from src.services._http import ResilientHttpClient
from src.services.ghl import (
    CONTACTS_SEARCH_URL,
    GHL_API_VERSION,
    GhlClient,
    GhlError,
    WebhookEvent,
    _first_str,
    _parse_ghl_datetime,
    _to_ghl_datetime,
    parse_webhook_event,
    real_cpl,
)


SHARED_SECRET = "test-secret-for-ghl-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")
    monkeypatch.setenv("GHL_API_KEY", "test-ghl-token")
    monkeypatch.delenv("FAKE_GHL", raising=False)

    from src.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


SINCE = datetime(2026, 5, 1, tzinfo=timezone.utc)
UNTIL = datetime(2026, 5, 8, tzinfo=timezone.utc)
IN_WINDOW = "2026-05-04T12:00:00.000Z"


def _client_with(handler) -> GhlClient:
    """Build a GhlClient whose resilient client uses a MockTransport handler.

    Injects an instant-sleep / zero-jitter resilient client so retries don't
    wait in tests.
    """

    async def _no_sleep(_d: float) -> None:
        return None

    http = ResilientHttpClient(
        headers={
            "Authorization": "Bearer test-ghl-token",
            "Version": GHL_API_VERSION,
        },
        transport=httpx.MockTransport(handler),
        sleep=_no_sleep,
        rng=lambda: 0.0,
    )
    return GhlClient(http_client=http)


def _contact(cid: str, *, source: str = "facebook", date: str = IN_WINDOW) -> dict:
    return {"id": cid, "dateAdded": date, "source": source}


# ---------------------------------------------------------------------------
# real_cpl
# ---------------------------------------------------------------------------


def test_real_cpl_basic() -> None:
    assert real_cpl(100.0, 5) == 20.0


def test_real_cpl_zero_leads_returns_none() -> None:
    assert real_cpl(75.0, 0) is None


def test_real_cpl_zero_spend() -> None:
    assert real_cpl(0.0, 4) == 0.0


def test_real_cpl_negative_raises() -> None:
    with pytest.raises(ValueError):
        real_cpl(-1.0, 5)
    with pytest.raises(ValueError):
        real_cpl(10.0, -2)


# ---------------------------------------------------------------------------
# parse_webhook_event
# ---------------------------------------------------------------------------


def test_parse_webhook_contact_create_is_lead() -> None:
    ev = parse_webhook_event(
        {
            "type": "ContactCreate",
            "contactId": "c-1",
            "locationId": "loc-1",
            "dateAdded": IN_WINDOW,
            "webhookId": "wh-99",
        }
    )
    assert isinstance(ev, WebhookEvent)
    assert ev.is_lead is True
    assert ev.contact_id == "c-1"
    assert ev.location_id == "loc-1"
    assert ev.created_at == datetime(2026, 5, 4, 12, 0, tzinfo=timezone.utc)
    assert ev.dedupe_key == "ghl:wh-99"


def test_parse_webhook_opportunity_create_is_lead() -> None:
    ev = parse_webhook_event({"type": "OpportunityCreate", "contactId": "c-2"})
    assert ev.is_lead is True
    assert ev.contact_id == "c-2"


def test_parse_webhook_non_lead_event() -> None:
    ev = parse_webhook_event({"type": "ContactDelete", "contactId": "c-3"})
    assert ev.is_lead is False


def test_parse_webhook_dedupe_key_falls_back_without_event_id() -> None:
    ev = parse_webhook_event(
        {"type": "ContactCreate", "contactId": "c-9", "dateAdded": IN_WINDOW}
    )
    assert ev.dedupe_key == "ghl:ContactCreate:c-9:2026-05-04T12:00:00+00:00"


def test_parse_webhook_dedupe_key_fully_degraded() -> None:
    ev = parse_webhook_event({"type": "ContactCreate"})
    assert ev.dedupe_key == "ghl:ContactCreate:no-contact:no-ts"
    assert ev.contact_id is None


def test_parse_webhook_nested_contact_id() -> None:
    ev = parse_webhook_event(
        {"type": "ContactCreate", "contact": {"id": "nested-1"}}
    )
    assert ev.contact_id == "nested-1"


def test_parse_webhook_missing_type_raises() -> None:
    with pytest.raises(GhlError, match="missing 'type'"):
        parse_webhook_event({"contactId": "c-1"})


def test_parse_webhook_non_dict_raises() -> None:
    with pytest.raises(GhlError, match="not an object"):
        parse_webhook_event(["not", "a", "dict"])  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Pure helpers — date + string parsing
# ---------------------------------------------------------------------------


def test_parse_datetime_iso_with_z() -> None:
    dt = _parse_ghl_datetime("2026-05-04T12:00:00.000Z")
    assert dt == datetime(2026, 5, 4, 12, 0, tzinfo=timezone.utc)


def test_parse_datetime_epoch_ms() -> None:
    # 2026-05-04T12:00:00Z in epoch-ms.
    ms = int(datetime(2026, 5, 4, 12, 0, tzinfo=timezone.utc).timestamp() * 1000)
    dt = _parse_ghl_datetime(str(ms))
    assert dt == datetime(2026, 5, 4, 12, 0, tzinfo=timezone.utc)


def test_parse_datetime_epoch_ms_overflow_returns_none() -> None:
    assert _parse_ghl_datetime("9" * 30) is None


def test_parse_datetime_naive_treated_as_utc() -> None:
    dt = _parse_ghl_datetime("2026-05-04T12:00:00")
    assert dt == datetime(2026, 5, 4, 12, 0, tzinfo=timezone.utc)


def test_parse_datetime_offset_normalized_to_utc() -> None:
    dt = _parse_ghl_datetime("2026-05-04T14:00:00+02:00")
    assert dt == datetime(2026, 5, 4, 12, 0, tzinfo=timezone.utc)


def test_parse_datetime_none_blank_garbage() -> None:
    assert _parse_ghl_datetime(None) is None
    assert _parse_ghl_datetime("   ") is None
    assert _parse_ghl_datetime("not-a-date") is None


def test_to_ghl_datetime_roundtrip_and_naive() -> None:
    out = _to_ghl_datetime(datetime(2026, 5, 4, 12, 0, tzinfo=timezone.utc))
    assert out == "2026-05-04T12:00:00Z"
    # A naive datetime is assumed UTC.
    naive = _to_ghl_datetime(datetime(2026, 5, 4, 12, 0))
    assert naive == "2026-05-04T12:00:00Z"


def test_first_str_numeric_value_stringified() -> None:
    # GHL sometimes sends ids as numbers.
    assert _first_str({"id": 12345}, "id") == "12345"
    # A bool is NOT treated as a numeric id.
    assert _first_str({"id": True}, "id") is None
    # Falls through to the next key.
    assert _first_str({"a": "", "b": "found"}, "a", "b") == "found"


# ---------------------------------------------------------------------------
# GhlClient construction
# ---------------------------------------------------------------------------


def test_client_requires_key_when_not_fake(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GHL_API_KEY", raising=False)
    from src.config import get_settings

    get_settings.cache_clear()
    with pytest.raises(RuntimeError, match="GHL_API_KEY"):
        GhlClient()


def test_client_explicit_key() -> None:
    c = GhlClient(api_key="explicit")
    assert c.api_key == "explicit"


def test_client_fake_mode_needs_no_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GHL_API_KEY", raising=False)
    monkeypatch.setenv("FAKE_GHL", "true")
    from src.config import get_settings

    get_settings.cache_clear()
    c = GhlClient()
    assert c.fake is True


# ---------------------------------------------------------------------------
# list_leads
# ---------------------------------------------------------------------------


def test_list_leads_happy_path() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("Authorization")
        seen["version"] = request.headers.get("Version")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"contacts": [_contact("c-1"), _contact("c-2")]},
        )

    client = _client_with(handler)
    leads = asyncio.run(client.list_leads("loc-1", SINCE, UNTIL))
    assert [lead.contact_id for lead in leads] == ["c-1", "c-2"]
    assert seen["url"] == CONTACTS_SEARCH_URL
    assert seen["auth"] == "Bearer test-ghl-token"
    assert seen["version"] == GHL_API_VERSION
    assert seen["body"]["locationId"] == "loc-1"


def test_list_leads_filters_out_of_window() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "contacts": [
                    _contact("c-in", date=IN_WINDOW),
                    _contact("c-before", date="2026-04-01T00:00:00.000Z"),
                    _contact("c-after", date="2026-06-01T00:00:00.000Z"),
                ]
            },
        )

    client = _client_with(handler)
    leads = asyncio.run(client.list_leads("loc-1", SINCE, UNTIL))
    assert [lead.contact_id for lead in leads] == ["c-in"]


def test_list_leads_source_filter() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "contacts": [
                    _contact("c-fb", source="Facebook Ads - Spring"),
                    _contact("c-goog", source="Google"),
                    _contact("c-none", source=""),
                ]
            },
        )

    client = _client_with(handler)
    leads = asyncio.run(
        client.list_leads("loc-1", SINCE, UNTIL, source_filter="facebook")
    )
    assert [lead.contact_id for lead in leads] == ["c-fb"]


def test_list_leads_paginates() -> None:
    pages: dict[int, list] = {
        1: [_contact(f"p1-{i}") for i in range(100)],
        2: [_contact("p2-0")],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        page = body["page"]
        return httpx.Response(200, json={"contacts": pages.get(page, [])})

    client = _client_with(handler)
    leads = asyncio.run(client.list_leads("loc-1", SINCE, UNTIL))
    assert len(leads) == 101  # 100 from page 1 + 1 from page 2


def test_list_leads_skips_malformed_contact() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "contacts": [
                    _contact("c-ok"),
                    {"id": "no-date"},  # missing dateAdded → dropped
                    "not-a-dict",  # not even a dict → dropped
                    {"dateAdded": IN_WINDOW},  # missing id → dropped
                ]
            },
        )

    client = _client_with(handler)
    leads = asyncio.run(client.list_leads("loc-1", SINCE, UNTIL))
    assert [lead.contact_id for lead in leads] == ["c-ok"]


def test_list_leads_since_after_until_raises() -> None:
    client = _client_with(lambda r: httpx.Response(200, json={"contacts": []}))
    with pytest.raises(GhlError, match="after until"):
        asyncio.run(client.list_leads("loc-1", UNTIL, SINCE))


def test_list_leads_permanent_error_maps_to_ghlerror() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "unauthorized"})

    client = _client_with(handler)
    with pytest.raises(GhlError) as ei:
        asyncio.run(client.list_leads("loc-1", SINCE, UNTIL))
    assert ei.value.transient is False
    assert ei.value.status_code == 401


def test_list_leads_transient_exhaustion_maps_to_transient_ghlerror() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    client = _client_with(handler)
    with pytest.raises(GhlError) as ei:
        asyncio.run(client.list_leads("loc-1", SINCE, UNTIL))
    assert ei.value.transient is True


def test_list_leads_non_json_body_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html>not json</html>")

    client = _client_with(handler)
    with pytest.raises(GhlError, match="not JSON"):
        asyncio.run(client.list_leads("loc-1", SINCE, UNTIL))


def test_list_leads_non_object_body_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=["unexpected", "array"])

    client = _client_with(handler)
    with pytest.raises(GhlError, match="not a JSON object"):
        asyncio.run(client.list_leads("loc-1", SINCE, UNTIL))


# ---------------------------------------------------------------------------
# count_leads_for_campaign
# ---------------------------------------------------------------------------


def test_count_leads_for_campaign() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "contacts": [
                    _contact("c-1", source="fb-camp-42"),
                    _contact("c-2", source="fb-camp-42"),
                    _contact("c-3", source="other"),
                ]
            },
        )

    client = _client_with(handler)
    n = asyncio.run(
        client.count_leads_for_campaign("loc-1", "camp-42", (SINCE, UNTIL))
    )
    assert n == 2


def test_count_then_real_cpl_end_to_end() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"contacts": [_contact("c-1"), _contact("c-2"), _contact("c-3")]},
        )

    client = _client_with(handler)
    leads = asyncio.run(
        client.count_leads_for_campaign("loc-1", "facebook", (SINCE, UNTIL))
    )
    assert leads == 3
    assert real_cpl(60.0, leads) == 20.0


# ---------------------------------------------------------------------------
# FAKE_GHL mode + lifecycle
# ---------------------------------------------------------------------------


def test_fake_mode_list_leads(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_GHL", "true")
    from src.config import get_settings

    get_settings.cache_clear()
    client = GhlClient()
    leads = asyncio.run(
        client.list_leads("loc-z", SINCE, UNTIL, source_filter="tiktok")
    )
    assert len(leads) == 2
    assert all(lead.source == "tiktok" for lead in leads)
    # And it feeds real_cpl with a non-zero count.
    assert real_cpl(40.0, len(leads)) == 20.0


def test_owns_client_aclose() -> None:
    async def drive() -> None:
        async with GhlClient(api_key="k") as client:
            assert client._owns_client is True
        # aclose again is a no-op.
        await client.aclose()

    asyncio.run(drive())


def test_injected_client_not_closed_by_connector() -> None:
    closed = {"v": False}

    async def _no_sleep(_d: float) -> None:
        return None

    class _SpyHttp(ResilientHttpClient):
        async def aclose(self) -> None:  # type: ignore[override]
            closed["v"] = True
            await super().aclose()

    spy = _SpyHttp(transport=httpx.MockTransport(lambda r: httpx.Response(200)), sleep=_no_sleep)

    async def drive() -> None:
        async with GhlClient(http_client=spy) as client:
            assert client._owns_client is False
        # The connector must NOT close a client it doesn't own.
        assert closed["v"] is False

    asyncio.run(drive())
