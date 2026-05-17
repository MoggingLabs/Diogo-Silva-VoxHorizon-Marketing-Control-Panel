"""Tests for the Meta Ads insights client.

We mock ``httpx.AsyncClient.get`` so we never hit Meta. The interesting
behaviors are:

* Token resolution from kwarg vs. env var.
* ``act_`` prefix normalization on the account ID.
* Field-set selection (base vs. base + video).
* Action-array → leads / hook_rate / drop_off_3s parsing.
* Cursor-following pagination.
* 4xx → :class:`MetaApiError` with the status code.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.services.meta import (
    BASE_FIELDS,
    VIDEO_FIELDS,
    CampaignInsight,
    MetaAdsClient,
    MetaApiError,
    _extract_leads,
    _extract_video_metrics,
    _row_to_insight,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_response(status_code: int, payload: dict[str, Any]) -> MagicMock:
    """Build a stand-in for an httpx response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = payload
    resp.text = str(payload)
    return resp


@pytest.fixture
def fake_token(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setenv("META_ADS_API_KEY", "test-token")
    return "test-token"


# ---------------------------------------------------------------------------
# Constructor / config
# ---------------------------------------------------------------------------


def test_constructor_requires_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("META_ADS_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="META_ADS_API_KEY"):
        MetaAdsClient()


def test_constructor_accepts_explicit_token() -> None:
    client = MetaAdsClient(access_token="explicit")
    assert client._token == "explicit"


def test_constructor_reads_env_var(fake_token: str) -> None:
    client = MetaAdsClient()
    assert client._token == fake_token


def test_constructor_strips_whitespace_from_token() -> None:
    client = MetaAdsClient(access_token=" with-pad   ")
    assert client._token == "with-pad"


def test_account_id_normalization() -> None:
    assert MetaAdsClient._normalize_account_id("123") == "act_123"
    assert MetaAdsClient._normalize_account_id("act_123") == "act_123"
    with pytest.raises(ValueError):
        MetaAdsClient._normalize_account_id("")


# ---------------------------------------------------------------------------
# Action-array parsers
# ---------------------------------------------------------------------------


def test_extract_leads_sums_all_known_action_types() -> None:
    row = {
        "actions": [
            {"action_type": "lead", "value": "3"},
            {"action_type": "onsite_conversion.lead_grouped", "value": "2"},
            {"action_type": "offsite_conversion.fb_pixel_lead", "value": "1.4"},
            {"action_type": "page_engagement", "value": "999"},  # ignored
        ]
    }
    assert _extract_leads(row) == 6


def test_extract_leads_with_no_actions_is_zero() -> None:
    assert _extract_leads({}) == 0
    assert _extract_leads({"actions": []}) == 0


def test_extract_video_metrics_basic_math() -> None:
    row = {
        "impressions": 10000,
        "video_3_sec_watched_actions": [{"action_type": "video_view", "value": "2500"}],
        "video_p25_watched_actions": [{"action_type": "video_view", "value": "1000"}],
        "video_p50_watched_actions": [{"action_type": "video_view", "value": "500"}],
        "video_avg_time_watched_actions": [{"action_type": "video_view", "value": "8.5"}],
    }
    hook, drop, view, watch = _extract_video_metrics(row)
    assert hook == pytest.approx(0.25)
    # drop_off = 1 - (vp25 / v3s) = 1 - 1000/2500 = 0.6
    assert drop == pytest.approx(0.6)
    assert view == pytest.approx(0.05)
    assert watch == pytest.approx(8.5)


def test_extract_video_metrics_zero_impressions_returns_none() -> None:
    assert _extract_video_metrics({"impressions": 0}) == (None, None, None, None)


# ---------------------------------------------------------------------------
# Row → CampaignInsight
# ---------------------------------------------------------------------------


def test_row_to_insight_image_set() -> None:
    row = {
        "campaign_id": "cmp-1",
        "campaign_name": "Test Campaign",
        "spend": "150.50",
        "impressions": "5000",
        "clicks": "75",
        "ctr": "1.5",  # Meta returns CTR as a percentage string
        "frequency": "2.3",
        "actions": [{"action_type": "lead", "value": "4"}],
    }
    insight = _row_to_insight(row, video_metrics=False)
    assert insight.campaign_id == "cmp-1"
    assert insight.spend == pytest.approx(150.50)
    assert insight.impressions == 5000
    assert insight.clicks == 75
    assert insight.ctr == pytest.approx(0.015)  # 1.5% → 0.015
    assert insight.frequency == pytest.approx(2.3)
    assert insight.leads == 4
    # No video fields requested → all None.
    assert insight.hook_rate is None
    assert insight.drop_off_3s is None


def test_row_to_insight_video_set_populates_engagement() -> None:
    row = {
        "campaign_id": "cmp-1",
        "campaign_name": "Video Campaign",
        "impressions": "1000",
        "clicks": "20",
        "ctr": "2.0",
        "frequency": "1.5",
        "spend": "100",
        "actions": [],
        "video_3_sec_watched_actions": [{"action_type": "video_view", "value": "300"}],
        "video_p25_watched_actions": [{"action_type": "video_view", "value": "150"}],
        "video_p50_watched_actions": [{"action_type": "video_view", "value": "75"}],
        "video_avg_time_watched_actions": [{"action_type": "video_view", "value": "6.0"}],
    }
    insight = _row_to_insight(row, video_metrics=True)
    assert insight.hook_rate == pytest.approx(0.3)
    assert insight.drop_off_3s == pytest.approx(0.5)
    assert insight.view_rate_avg == pytest.approx(0.075)
    assert insight.watch_time_p50 == pytest.approx(6.0)


# ---------------------------------------------------------------------------
# fetch_campaign_insights — happy path + pagination + errors
# ---------------------------------------------------------------------------


def _make_async_client(get: AsyncMock) -> AsyncMock:
    """Wrap an AsyncMock so it acts as the internal httpx.AsyncClient."""
    fake = AsyncMock()
    fake.get = get
    fake.aclose = AsyncMock(return_value=None)
    return fake


def test_fetch_insights_image_field_set(
    fake_token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Image pulls request only BASE_FIELDS (no video fields)."""
    captured: list[tuple[str, dict[str, Any]]] = []

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        captured.append((url, params or {}))
        return _mock_response(
            200,
            {
                "data": [
                    {
                        "campaign_id": "cmp-1",
                        "campaign_name": "img-1",
                        "spend": "50",
                        "impressions": "100",
                        "clicks": "5",
                        "ctr": "5.0",
                        "frequency": "1.0",
                    }
                ],
                "paging": {},
            },
        )

    async def _run() -> list[CampaignInsight]:
        async with MetaAdsClient() as client:
            client._client = _make_async_client(AsyncMock(side_effect=fake_get))
            return await client.fetch_campaign_insights("act_123", 7)

    rows = asyncio.run(_run())
    assert len(rows) == 1
    assert rows[0].campaign_id == "cmp-1"
    assert rows[0].ctr == pytest.approx(0.05)

    fields_param = captured[0][1].get("fields", "")
    for f in BASE_FIELDS:
        assert f in fields_param
    for f in VIDEO_FIELDS:
        assert f not in fields_param


def test_fetch_insights_video_field_set(fake_token: str) -> None:
    """Video pulls add all VIDEO_FIELDS on top of BASE_FIELDS."""
    captured: list[tuple[str, dict[str, Any]]] = []

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        captured.append((url, params or {}))
        return _mock_response(200, {"data": [], "paging": {}})

    async def _run() -> list[CampaignInsight]:
        async with MetaAdsClient() as client:
            client._client = _make_async_client(AsyncMock(side_effect=fake_get))
            return await client.fetch_campaign_insights("123", 30, video_metrics=True)

    asyncio.run(_run())
    fields_param = captured[0][1].get("fields", "")
    for f in BASE_FIELDS:
        assert f in fields_param
    for f in VIDEO_FIELDS:
        assert f in fields_param


def test_fetch_insights_uses_act_prefix(fake_token: str) -> None:
    captured: list[str] = []

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        captured.append(url)
        return _mock_response(200, {"data": [], "paging": {}})

    async def _run() -> None:
        async with MetaAdsClient() as client:
            client._client = _make_async_client(AsyncMock(side_effect=fake_get))
            await client.fetch_campaign_insights("567", 7)

    asyncio.run(_run())
    assert "/act_567/insights" in captured[0]


def test_fetch_insights_follows_pagination_cursor(fake_token: str) -> None:
    """Two pages → one combined result list."""
    pages = [
        _mock_response(
            200,
            {
                "data": [{"campaign_id": "a", "campaign_name": "A", "impressions": "1"}],
                "paging": {"next": "https://graph.facebook.com/v21.0/next-page"},
            },
        ),
        _mock_response(
            200,
            {"data": [{"campaign_id": "b", "campaign_name": "B", "impressions": "2"}]},
        ),
    ]

    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        return pages.pop(0)

    async def _run() -> list[CampaignInsight]:
        async with MetaAdsClient() as client:
            client._client = _make_async_client(AsyncMock(side_effect=fake_get))
            return await client.fetch_campaign_insights("act_1", 7)

    rows = asyncio.run(_run())
    assert [r.campaign_id for r in rows] == ["a", "b"]


def test_fetch_insights_raises_on_4xx(fake_token: str) -> None:
    async def fake_get(url: str, params: dict[str, Any] | None = None) -> MagicMock:
        resp = MagicMock()
        resp.status_code = 400
        resp.text = "bad token"
        resp.json.return_value = {"error": {"message": "bad token"}}
        return resp

    async def _run() -> None:
        async with MetaAdsClient() as client:
            client._client = _make_async_client(AsyncMock(side_effect=fake_get))
            await client.fetch_campaign_insights("act_1", 7)

    with pytest.raises(MetaApiError) as exc_info:
        asyncio.run(_run())
    assert exc_info.value.status == 400


def test_fetch_insights_window_to_date_preset(fake_token: str) -> None:
    """Sanity: 1 → yesterday, 7 → last_7d, 30 → last_30d."""
    from src.services.meta import _date_preset_for_window

    assert _date_preset_for_window(1) == "yesterday"
    assert _date_preset_for_window(7) == "last_7d"
    assert _date_preset_for_window(30) == "last_30d"
    # Unknown windows fall back to last_30d.
    assert _date_preset_for_window(45) == "last_30d"
