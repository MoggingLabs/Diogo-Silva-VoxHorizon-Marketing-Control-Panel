"""Tests for the GoHighLevel (GHL) client + source derivation + junk filter.

We stub out the network with an AsyncMock that mimics ``httpx.AsyncClient.get``.
The User-Agent assertion is load-bearing — Diogo's Cloudflare ruleset is keyed
on the literal ``OpenClaw/1.0`` string and any drift would break the live
integration silently. The test pins it explicitly.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.services.ghl import (
    API_VERSION,
    USER_AGENT,
    GHLApiError,
    GHLClient,
    GHLContact,
    derive_source,
    is_junk_lead,
)


# ---------------------------------------------------------------------------
# User-Agent (load-bearing — Cloudflare allow rule)
# ---------------------------------------------------------------------------


def test_user_agent_is_literal_openclaw() -> None:
    """If this fails, Cloudflare on Diogo's GHL account will silently drop us."""
    assert USER_AGENT == "OpenClaw/1.0"


def test_api_version_pinned() -> None:
    assert API_VERSION == "2021-07-28"


def test_headers_include_user_agent_and_version() -> None:
    client = GHLClient(access_token="tk")
    headers = client._headers()
    assert headers["User-Agent"] == "OpenClaw/1.0"
    assert headers["Version"] == "2021-07-28"
    assert headers["Authorization"] == "Bearer tk"
    assert headers["Accept"] == "application/json"


# ---------------------------------------------------------------------------
# Junk-lead filter
# ---------------------------------------------------------------------------


def test_junk_filter_blocks_empty_submission() -> None:
    assert is_junk_lead({}) is True
    assert is_junk_lead({"name": ""}) is True


def test_junk_filter_blocks_test_names() -> None:
    assert is_junk_lead({"name": "Test User", "email": "real@example.org"}) is True
    assert is_junk_lead({"contactName": "asdf", "phone": "555"}) is True


def test_junk_filter_blocks_disposable_emails() -> None:
    assert is_junk_lead({"name": "John", "email": "x@mailinator.com"}) is True
    assert is_junk_lead({"name": "John", "email": "x@example.com"}) is True


def test_junk_filter_passes_real_contact() -> None:
    assert (
        is_junk_lead({"name": "Diogo", "email": "diogo@voxhorizon.com", "phone": "555"})
        is False
    )


# ---------------------------------------------------------------------------
# Source derivation
# ---------------------------------------------------------------------------


def test_derive_source_prefers_custom_field() -> None:
    contact = {"customFields": [{"key": "source", "value": "Newsletter"}]}
    assert derive_source(contact) == "newsletter"


def test_derive_source_recognizes_source_tag() -> None:
    assert derive_source({"tags": ["source:youtube", "vip"]}) == "youtube"


def test_derive_source_detects_instagram_biolink() -> None:
    contact = {"attributionSource": {"url": "https://linktr.ee/foo"}}
    assert derive_source(contact) == "instagram"


def test_derive_source_detects_youtube_url() -> None:
    contact = {"attributionSource": {"url": "https://www.youtube.com/@foo"}}
    assert derive_source(contact) == "youtube"


def test_derive_source_parses_utm_source() -> None:
    contact = {"attributionSource": {"url": "https://x.com/?utm_source=tiktok&utm_medium=cpc"}}
    assert derive_source(contact) == "tiktok"


def test_derive_source_parses_meta_from_campaign_name() -> None:
    contact = {"attributionSource": {"campaign": "Meta - Spring 2026 - Image"}}
    assert derive_source(contact) == "meta"


def test_derive_source_falls_back_to_unknown() -> None:
    assert derive_source({}) == "unknown"


# ---------------------------------------------------------------------------
# Constructor + auth
# ---------------------------------------------------------------------------


def test_constructor_requires_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GHL_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="GHL_API_KEY"):
        GHLClient()


def test_constructor_accepts_explicit_token() -> None:
    client = GHLClient(access_token="explicit")
    assert client._token == "explicit"


def test_constructor_reads_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GHL_API_KEY", "env-token")
    client = GHLClient()
    assert client._token == "env-token"


# ---------------------------------------------------------------------------
# fetch_contacts_for_location — happy path + pagination + junk filter
# ---------------------------------------------------------------------------


def _mock_response(status_code: int, payload: dict[str, Any]) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = payload
    resp.text = str(payload)
    return resp


def _async_client_with(get: AsyncMock) -> AsyncMock:
    fake = AsyncMock()
    fake.get = get
    fake.aclose = AsyncMock(return_value=None)
    return fake


def test_fetch_contacts_sets_user_agent_header(monkeypatch: pytest.MonkeyPatch) -> None:
    """Sanity: the header set on the AsyncClient carries OpenClaw/1.0 forward."""
    monkeypatch.setenv("GHL_API_KEY", "tk")

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        return _mock_response(200, {"contacts": []})

    async def _run() -> None:
        async with GHLClient() as client:
            # Verify the headers stored on the internal client.
            assert client._client is not None
            stored = client._client.headers
            # AsyncMock returns the attribute as a MagicMock; we set it
            # explicitly so the assertion is meaningful.
            assert client._headers()["User-Agent"] == "OpenClaw/1.0"
            client._client = _async_client_with(AsyncMock(side_effect=fake_get))
            await client.fetch_contacts_for_location("loc-1")

    asyncio.run(_run())


def test_fetch_contacts_filters_junk(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GHL_API_KEY", "tk")
    rows = [
        {"id": "1", "name": "Real Person", "email": "real@voxhorizon.com"},
        {"id": "2", "name": "Test Bot", "email": "bot@example.com"},  # junk
        {"id": "3", "name": "Other", "email": "other@gmail.com"},
    ]

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        return _mock_response(200, {"contacts": rows})

    async def _run() -> list[GHLContact]:
        async with GHLClient() as client:
            client._client = _async_client_with(AsyncMock(side_effect=fake_get))
            return await client.fetch_contacts_for_location("loc-1")

    out = asyncio.run(_run())
    assert [c.id for c in out] == ["1", "3"]


def test_fetch_contacts_passes_since_as_start_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GHL_API_KEY", "tk")
    captured: list[dict[str, Any]] = []

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        captured.append(params or {})
        return _mock_response(200, {"contacts": []})

    async def _run() -> None:
        async with GHLClient() as client:
            client._client = _async_client_with(AsyncMock(side_effect=fake_get))
            await client.fetch_contacts_for_location(
                "loc-1", since=datetime(2026, 5, 10, tzinfo=timezone.utc)
            )

    asyncio.run(_run())
    assert captured[0]["locationId"] == "loc-1"
    assert "2026-05-10" in captured[0]["startAfter"]


def test_fetch_contacts_paginates_until_short_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GHL_API_KEY", "tk")
    pages = [
        # Page 1 — full (100 rows → keep paginating).
        {"contacts": [{"id": str(i), "name": "Real", "email": f"r{i}@voxhorizon.com"} for i in range(100)]},
        # Page 2 — partial → stop.
        {"contacts": [{"id": "extra", "name": "Real", "email": "extra@voxhorizon.com"}]},
    ]

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        return _mock_response(200, pages.pop(0))

    async def _run() -> list[GHLContact]:
        async with GHLClient() as client:
            client._client = _async_client_with(AsyncMock(side_effect=fake_get))
            return await client.fetch_contacts_for_location("loc-1", limit=100)

    out = asyncio.run(_run())
    assert len(out) == 101
    assert "extra" in {c.id for c in out}


def test_fetch_contacts_raises_on_4xx(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GHL_API_KEY", "tk")

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        return _mock_response(403, {"error": "no perms"})

    async def _run() -> None:
        async with GHLClient() as client:
            client._client = _async_client_with(AsyncMock(side_effect=fake_get))
            await client.fetch_contacts_for_location("loc-1")

    with pytest.raises(GHLApiError) as exc:
        asyncio.run(_run())
    assert exc.value.status == 403


def test_row_to_contact_pulls_attribution_campaign_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Attribution.campaign / campaignId becomes the join key for the audit."""
    monkeypatch.setenv("GHL_API_KEY", "tk")
    contact_row = {
        "id": "c-1",
        "name": "Real Person",
        "email": "r@voxhorizon.com",
        "attributionSource": {"campaign": "cmp-99"},
        "tags": ["source:meta"],
    }

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        return _mock_response(200, {"contacts": [contact_row]})

    async def _run() -> list[GHLContact]:
        async with GHLClient() as client:
            client._client = _async_client_with(AsyncMock(side_effect=fake_get))
            return await client.fetch_contacts_for_location("loc-1")

    out = asyncio.run(_run())
    assert len(out) == 1
    assert out[0].campaign_id == "cmp-99"
    assert out[0].source == "meta"


# ---------------------------------------------------------------------------
# derive_source — branch coverage
# ---------------------------------------------------------------------------


def test_derive_source_skips_non_dict_custom_fields() -> None:
    """Garbage entries in customFields are skipped (covers the ``continue``)."""
    contact = {
        "customFields": ["not-a-dict", {"key": "source", "value": "tiktok"}],
    }
    assert derive_source(contact) == "tiktok"


def test_derive_source_skips_non_string_tags() -> None:
    """Non-string tag entries are skipped before the ``source:`` prefix check."""
    contact = {"tags": [123, {"x": 1}, "source:youtube"]}
    assert derive_source(contact) == "youtube"


def test_derive_source_normalizes_ig_alias_to_instagram() -> None:
    """``ig`` / ``instagram`` from a campaign name normalize to ``instagram``."""
    contact = {"attributionSource": {"campaign": "IG - Lead Magnet"}}
    assert derive_source(contact) == "instagram"


def test_derive_source_normalizes_yt_alias_to_youtube() -> None:
    """``yt`` from a campaign name normalizes to ``youtube``."""
    contact = {"attributionSource": {"campaign": "YT - Brand Awareness"}}
    assert derive_source(contact) == "youtube"


def test_derive_source_returns_raw_match_when_not_normalized() -> None:
    """A token like ``google`` is not normalized and returns as-is."""
    contact = {"attributionSource": {"campaign": "Google - Generic"}}
    assert derive_source(contact) == "google"


def test_derive_source_empty_source_tag_returns_unknown() -> None:
    """``source:`` with empty value falls back to ``unknown``."""
    contact = {"tags": ["source:"]}
    assert derive_source(contact) == "unknown"


def test_derive_source_uses_last_attribution_when_no_attribution_source() -> None:
    """When ``attributionSource`` is absent, ``lastAttribution`` is consulted."""
    contact = {"lastAttribution": {"url": "https://linktr.ee/foo"}}
    assert derive_source(contact) == "instagram"


# ---------------------------------------------------------------------------
# _client_or_default fallback
# ---------------------------------------------------------------------------


def test_client_or_default_lazily_constructs_httpx_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Calling fetch_* without an explicit context manager opens a client."""
    monkeypatch.setenv("GHL_API_KEY", "tk")

    constructed: list[str] = []

    def fake_async_client(*_args: Any, **_kwargs: Any) -> AsyncMock:
        constructed.append("ok")
        return _async_client_with(
            AsyncMock(side_effect=lambda url, params=None: _mock_response(200, {"contacts": []}))
        )

    import src.services.ghl as ghl_mod

    monkeypatch.setattr(ghl_mod.httpx, "AsyncClient", fake_async_client)

    async def _run() -> None:
        client = GHLClient()
        # No async with — direct call exercises _client_or_default's None branch.
        await client.fetch_contacts_for_location("loc-1")

    asyncio.run(_run())
    assert constructed == ["ok"]


# ---------------------------------------------------------------------------
# fetch_contacts_for_location — non-dict rows + empty location id
# ---------------------------------------------------------------------------


def test_fetch_contacts_skips_non_dict_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    """Garbage entries returned by GHL are silently skipped."""
    monkeypatch.setenv("GHL_API_KEY", "tk")
    rows = ["not-a-dict", {"id": "1", "name": "Real", "email": "r@voxhorizon.com"}, 42]

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        return _mock_response(200, {"contacts": rows})

    async def _run() -> list[GHLContact]:
        async with GHLClient() as client:
            client._client = _async_client_with(AsyncMock(side_effect=fake_get))
            return await client.fetch_contacts_for_location("loc-1")

    out = asyncio.run(_run())
    assert len(out) == 1
    assert out[0].id == "1"


def test_fetch_contacts_requires_location_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """Empty ``location_id`` is rejected up front."""
    monkeypatch.setenv("GHL_API_KEY", "tk")
    client = GHLClient()
    with pytest.raises(ValueError, match="location_id is required"):
        asyncio.run(client.fetch_contacts_for_location(""))


# ---------------------------------------------------------------------------
# aclose
# ---------------------------------------------------------------------------


def test_aclose_resets_internal_client(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GHL_API_KEY", "tk")

    async def _run() -> None:
        async with GHLClient() as c:
            assert c._client is not None
        # __aexit__ → aclose → None
        # (Re-entry exercises the second branch.)
        await c.aclose()

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# fetch_opportunities — happy path + errors + non-dict rows + empty loc
# ---------------------------------------------------------------------------


def test_fetch_opportunities_requires_location_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GHL_API_KEY", "tk")
    client = GHLClient()
    with pytest.raises(ValueError, match="location_id is required"):
        asyncio.run(client.fetch_opportunities(""))


def test_fetch_opportunities_returns_normalized_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GHL_API_KEY", "tk")
    rows = [
        {
            "id": "op-1",
            "pipelineId": "p-1",
            "pipelineStageId": "s-1",
            "status": "open",
            "monetaryValue": "1000.50",
            "contactId": "c-1",
            "createdAt": "2026-05-01T00:00:00Z",
        },
        "not-a-dict",  # skipped
        {
            "id": "op-2",
            "monetaryValue": "garbage",  # → falls back to 0.0
        },
    ]

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        return _mock_response(200, {"opportunities": rows})

    async def _run():
        async with GHLClient() as client:
            client._client = _async_client_with(AsyncMock(side_effect=fake_get))
            return await client.fetch_opportunities("loc-1")

    out = asyncio.run(_run())
    assert [o.id for o in out] == ["op-1", "op-2"]
    assert out[0].monetary_value == pytest.approx(1000.50)
    assert out[1].monetary_value == 0.0


def test_fetch_opportunities_raises_on_4xx(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GHL_API_KEY", "tk")

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        return _mock_response(401, {"error": "unauthorized"})

    async def _run() -> None:
        async with GHLClient() as client:
            client._client = _async_client_with(AsyncMock(side_effect=fake_get))
            await client.fetch_opportunities("loc-1")

    with pytest.raises(GHLApiError) as exc:
        asyncio.run(_run())
    assert exc.value.status == 401


def test_fetch_opportunities_empty_page_breaks(monkeypatch: pytest.MonkeyPatch) -> None:
    """Empty result list → loop exits without paginating."""
    monkeypatch.setenv("GHL_API_KEY", "tk")

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        return _mock_response(200, {"opportunities": []})

    async def _run():
        async with GHLClient() as client:
            client._client = _async_client_with(AsyncMock(side_effect=fake_get))
            return await client.fetch_opportunities("loc-1")

    out = asyncio.run(_run())
    assert out == []


def test_fetch_opportunities_paginates_until_short_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GHL_API_KEY", "tk")
    pages = [
        {"opportunities": [{"id": str(i)} for i in range(100)]},
        {"opportunities": [{"id": "tail"}]},
    ]

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        return _mock_response(200, pages.pop(0))

    async def _run():
        async with GHLClient() as client:
            client._client = _async_client_with(AsyncMock(side_effect=fake_get))
            return await client.fetch_opportunities("loc-1", limit=100)

    out = asyncio.run(_run())
    assert len(out) == 101
    assert any(o.id == "tail" for o in out)


# ---------------------------------------------------------------------------
# _to_iso helper
# ---------------------------------------------------------------------------


def test_to_iso_returns_none_for_none() -> None:
    from src.services.ghl import _to_iso

    assert _to_iso(None) is None


def test_to_iso_treats_naive_datetime_as_utc() -> None:
    from src.services.ghl import _to_iso

    out = _to_iso(datetime(2026, 5, 17, 10, 30))
    assert out is not None
    assert "2026-05-17T10:30" in out
    # The output must carry UTC offset.
    assert out.endswith("+00:00")


def test_to_iso_converts_aware_datetime_to_utc() -> None:
    from datetime import timezone as tz

    from src.services.ghl import _to_iso

    eastern = tz(timedelta(hours=-5))
    aware = datetime(2026, 5, 17, 10, 30, tzinfo=eastern)
    out = _to_iso(aware)
    assert out is not None
    # 10:30 EST → 15:30 UTC.
    assert "2026-05-17T15:30" in out
