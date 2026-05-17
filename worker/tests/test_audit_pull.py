"""Tests for the audit pull orchestrator.

The orchestrator's contract:

* Pulls Meta + GHL concurrently for each client.
* Joins by campaign_id; missing GHL just means ``leads_ghl = 0``.
* Persists via :mod:`audit_persist` (image vs. video table by format).
* Emits a ``kill_threshold`` notification per kill-verdict row.

All upstream HTTP traffic is mocked. The verdict + persist surfaces are
mocked too — we only want to verify the orchestrator stitches the pieces
together correctly.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.services import audit_pull as ap
from src.services.audit_pull import (
    AuditReport,
    ClientRow,
    JoinedRow,
    fetch_clients,
    join_by_campaign,
    run_audit,
)
from src.services.ghl import GHLContact
from src.services.meta import CampaignInsight


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


@dataclass
class _SupabaseStub:
    """Mini Supabase stand-in for fetch_clients."""

    rows: list[dict[str, Any]]

    def table(self, _name: str) -> "_SupabaseTable":
        return _SupabaseTable(self.rows)


@dataclass
class _SupabaseTable:
    rows: list[dict[str, Any]]
    _filters: list[tuple[str, str, Any]] | None = None

    def select(self, _cols: str) -> "_SupabaseTable":
        self._filters = []
        return self

    def eq(self, col: str, val: Any) -> "_SupabaseTable":
        assert self._filters is not None
        self._filters.append((col, "eq", val))
        return self

    def execute(self) -> Any:
        result = list(self.rows)
        for col, op, val in self._filters or []:
            if op == "eq":
                result = [r for r in result if r.get(col) == val]
        return MagicMock(data=result)


@pytest.fixture
def stub_sb(monkeypatch: pytest.MonkeyPatch) -> _SupabaseStub:
    rows: list[dict[str, Any]] = []
    stub = _SupabaseStub(rows=rows)
    monkeypatch.setattr(ap, "get_supabase_admin", lambda: stub)
    return stub


def _client(**over: Any) -> ClientRow:
    base = {
        "id": "cli-1",
        "name": "Acme",
        "slug": "acme",
        "meta_account_id": "act_123",
        "ghl_location_id": "loc-1",
        "cpl_target": 25.0,
    }
    base.update(over)
    return ClientRow(**base)


def _insight(**over: Any) -> CampaignInsight:
    base = {
        "campaign_id": "cmp-1",
        "campaign_name": "Test Campaign",
        "spend": 100.0,
        "impressions": 5000,
        "clicks": 50,
        "ctr": 0.01,
        "frequency": 1.5,
        "leads": 2,
    }
    base.update(over)
    return CampaignInsight(**base)


def _contact(**over: Any) -> GHLContact:
    base = {
        "id": "g-1",
        "location_id": "loc-1",
        "email": "x@y.com",
        "phone": "555",
        "name": "X",
        "source": "meta",
        "campaign_id": "cmp-1",
        "created_at": "2026-05-10T00:00:00Z",
    }
    base.update(over)
    return GHLContact(**base)


# ---------------------------------------------------------------------------
# fetch_clients
# ---------------------------------------------------------------------------


def test_fetch_clients_returns_active_clients_with_meta(stub_sb: _SupabaseStub) -> None:
    stub_sb.rows.extend(
        [
            {
                "id": "a",
                "name": "Acme",
                "slug": "acme",
                "meta_account_id": "act_1",
                "ghl_location_id": "loc-1",
                "cpl_target": 25.0,
                "status": "active",
            },
            {
                "id": "b",
                "name": "Inactive",
                "slug": "inactive",
                "meta_account_id": "act_2",
                "ghl_location_id": "loc-2",
                "cpl_target": None,
                "status": "paused",
            },
            {
                "id": "c",
                "name": "NoMeta",
                "slug": "no-meta",
                "meta_account_id": "",
                "ghl_location_id": "loc-3",
                "cpl_target": None,
                "status": "active",
            },
        ]
    )
    out = asyncio.run(fetch_clients(None))
    assert [c.id for c in out] == ["a"]


def test_fetch_clients_filters_by_id(stub_sb: _SupabaseStub) -> None:
    stub_sb.rows.extend(
        [
            {
                "id": "a",
                "name": "A",
                "slug": "a",
                "meta_account_id": "act_1",
                "ghl_location_id": "l",
                "cpl_target": 10,
                "status": "active",
            },
            {
                "id": "b",
                "name": "B",
                "slug": "b",
                "meta_account_id": "act_2",
                "ghl_location_id": "l",
                "cpl_target": 10,
                "status": "active",
            },
        ]
    )
    out = asyncio.run(fetch_clients("b"))
    assert [c.id for c in out] == ["b"]


# ---------------------------------------------------------------------------
# join_by_campaign
# ---------------------------------------------------------------------------


def test_join_meta_only_zero_ghl_leads() -> None:
    rows = join_by_campaign(
        [_insight(campaign_id="cmp-A", leads=3, spend=60.0)],
        [],
        client=_client(),
        window_days=7,
        format="image",
    )
    assert len(rows) == 1
    assert rows[0].leads_meta == 3
    assert rows[0].leads_ghl == 0
    # cpl_real = spend / total_leads = 60 / 3
    assert rows[0].cpl_real == pytest.approx(20.0)


def test_join_adds_ghl_lead_counts() -> None:
    rows = join_by_campaign(
        [_insight(campaign_id="cmp-A", leads=2, spend=80.0)],
        [_contact(campaign_id="cmp-A"), _contact(id="g-2", campaign_id="cmp-A")],
        client=_client(),
        window_days=7,
        format="image",
    )
    assert rows[0].leads_meta == 2
    assert rows[0].leads_ghl == 2
    # total leads = 4 → cpl = 80/4 = 20
    assert rows[0].cpl_real == pytest.approx(20.0)


def test_join_drops_ghl_contacts_without_campaign_id() -> None:
    rows = join_by_campaign(
        [_insight(campaign_id="cmp-A", leads=0, spend=10.0)],
        [_contact(campaign_id="")],
        client=_client(),
        window_days=7,
        format="image",
    )
    assert rows[0].leads_ghl == 0


def test_join_zero_leads_yields_none_cpl() -> None:
    rows = join_by_campaign(
        [_insight(campaign_id="cmp-A", leads=0, spend=10.0)],
        [],
        client=_client(),
        window_days=7,
        format="image",
    )
    assert rows[0].cpl_real is None


def test_join_video_format_propagates_engagement() -> None:
    rows = join_by_campaign(
        [_insight(campaign_id="cmp-A", hook_rate=0.3, drop_off_3s=0.5, view_rate_avg=0.1, watch_time_p50=6.0)],
        [],
        client=_client(),
        window_days=7,
        format="video",
    )
    assert rows[0].hook_rate == pytest.approx(0.3)
    assert rows[0].drop_off_3s == pytest.approx(0.5)


def test_join_image_format_drops_engagement() -> None:
    rows = join_by_campaign(
        [_insight(campaign_id="cmp-A", hook_rate=0.3, drop_off_3s=0.5)],
        [],
        client=_client(),
        window_days=7,
        format="image",
    )
    assert rows[0].hook_rate is None
    assert rows[0].drop_off_3s is None


# ---------------------------------------------------------------------------
# run_audit — end-to-end orchestration (every dep mocked)
# ---------------------------------------------------------------------------


def _setup_mocks(
    monkeypatch: pytest.MonkeyPatch,
    *,
    insights: list[CampaignInsight],
    contacts: list[GHLContact],
    clients: list[ClientRow] | None = None,
) -> tuple[MagicMock, MagicMock, list[Any]]:
    """Mock the Meta + GHL clients, the persist surface, and the emit fn.

    Returns (upsert_image_mock, upsert_video_mock, emitted_events).
    """
    # fetch_clients pass-through. Use `is None` so callers can pass [] to
    # exercise the "no clients" branch.
    cls = [_client()] if clients is None else clients

    async def fake_fetch_clients(_client_id: str | None) -> list[ClientRow]:
        return cls

    monkeypatch.setattr(ap, "fetch_clients", fake_fetch_clients)

    # Meta client — context manager + fetch_campaign_insights.
    meta_instance = MagicMock()
    meta_instance.fetch_campaign_insights = AsyncMock(return_value=insights)
    meta_instance.__aenter__ = AsyncMock(return_value=meta_instance)
    meta_instance.__aexit__ = AsyncMock(return_value=None)
    meta_instance.aclose = AsyncMock(return_value=None)
    monkeypatch.setattr(ap, "MetaAdsClient", MagicMock(return_value=meta_instance))

    # GHL client — same shape.
    ghl_instance = MagicMock()
    ghl_instance.fetch_contacts_for_location = AsyncMock(return_value=contacts)
    ghl_instance.__aenter__ = AsyncMock(return_value=ghl_instance)
    ghl_instance.aclose = AsyncMock(return_value=None)
    monkeypatch.setattr(ap, "GHLClient", MagicMock(return_value=ghl_instance))

    # Persist hooks return upserted count.
    upsert_image = AsyncMock(return_value=1)
    upsert_video = AsyncMock(return_value=1)
    monkeypatch.setattr(ap, "upsert_image_perf", upsert_image)
    monkeypatch.setattr(ap, "upsert_video_perf", upsert_video)

    # Capture emit() calls.
    emitted: list[Any] = []

    async def fake_emit(event: Any) -> bool:
        emitted.append(event)
        return True

    monkeypatch.setattr(ap, "emit", fake_emit)

    return upsert_image, upsert_video, emitted


def test_run_audit_image_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    upsert_image, upsert_video, emitted = _setup_mocks(
        monkeypatch,
        insights=[_insight(campaign_id="cmp-A", leads=3, spend=20.0)],
        contacts=[_contact(campaign_id="cmp-A")],
    )

    report = asyncio.run(run_audit(format="image", window_days=7))

    assert report.format == "image"
    assert report.clients_processed == 1
    assert report.rows_processed == 1
    assert report.rows_upserted == 1
    assert report.kills == 0
    upsert_image.assert_awaited_once()
    upsert_video.assert_not_awaited()
    assert emitted == []


def test_run_audit_video_uses_video_field_set(monkeypatch: pytest.MonkeyPatch) -> None:
    upsert_image, upsert_video, _ = _setup_mocks(
        monkeypatch,
        insights=[
            _insight(
                campaign_id="cmp-A",
                hook_rate=0.4,
                drop_off_3s=0.3,
                view_rate_avg=0.15,
                watch_time_p50=8.0,
            )
        ],
        contacts=[],
    )

    asyncio.run(run_audit(format="video", window_days=7))

    upsert_video.assert_awaited_once()
    upsert_image.assert_not_awaited()
    # The Meta call must have requested video_metrics=True.
    meta_call_kwargs = ap.MetaAdsClient.return_value.fetch_campaign_insights.await_args.kwargs  # type: ignore[attr-defined]
    assert meta_call_kwargs.get("video_metrics") is True


def test_run_audit_emits_kill_notifications(monkeypatch: pytest.MonkeyPatch) -> None:
    """$100 spend with zero leads should land as a kill verdict + emit."""
    _, _, emitted = _setup_mocks(
        monkeypatch,
        insights=[_insight(campaign_id="cmp-A", spend=120.0, leads=0)],
        contacts=[],
    )

    report = asyncio.run(run_audit(format="image", window_days=7))

    assert report.kills == 1
    assert report.notifications_emitted == 1
    assert len(emitted) == 1
    ev = emitted[0]
    assert ev.kind == "kill_threshold"
    assert ev.ref_table == "campaign_perf_image"
    assert "kill:image:cmp-A" == ev.dedupe_key
    # Dedupe window is 24h (60*24) to avoid daily spam.
    assert ev.dedupe_window_minutes == 60 * 24
    assert ev.payload["campaign_id"] == "cmp-A"
    assert ev.payload["format"] == "image"
    assert ev.payload["verdict_reason"]


def test_run_audit_rejects_invalid_format() -> None:
    with pytest.raises(ValueError, match="format must be"):
        asyncio.run(run_audit(format="audio", window_days=7))  # type: ignore[arg-type]


def test_run_audit_rejects_invalid_window() -> None:
    with pytest.raises(ValueError, match="window_days"):
        asyncio.run(run_audit(format="image", window_days=999))  # type: ignore[arg-type]


def test_run_audit_no_clients_returns_empty_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _setup_mocks(monkeypatch, insights=[], contacts=[], clients=[])
    report = asyncio.run(run_audit(format="image", window_days=7))
    assert report.clients_processed == 0
    assert report.rows_processed == 0
    assert report.kills == 0


def test_run_audit_continues_when_client_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failure on one client must not abort the entire run."""
    bad = _client(id="bad", name="Bad", meta_account_id="act_bad")
    good = _client(id="good", name="Good", meta_account_id="act_good")

    insights_by_acc = {"act_good": [_insight(campaign_id="cmp-good", spend=10.0, leads=1)]}

    # Custom Meta mock that throws for the bad account.
    meta_instance = MagicMock()

    async def fake_fetch(acc: str, _window: int, **_kw: Any) -> list[CampaignInsight]:
        if acc == "act_bad":
            raise RuntimeError("meta down")
        return insights_by_acc.get(acc, [])

    meta_instance.fetch_campaign_insights = AsyncMock(side_effect=fake_fetch)
    meta_instance.__aenter__ = AsyncMock(return_value=meta_instance)
    meta_instance.__aexit__ = AsyncMock(return_value=None)
    monkeypatch.setattr(ap, "MetaAdsClient", MagicMock(return_value=meta_instance))

    ghl_instance = MagicMock()
    ghl_instance.fetch_contacts_for_location = AsyncMock(return_value=[])
    ghl_instance.__aenter__ = AsyncMock(return_value=ghl_instance)
    ghl_instance.aclose = AsyncMock(return_value=None)
    monkeypatch.setattr(ap, "GHLClient", MagicMock(return_value=ghl_instance))

    async def fake_fetch_clients(_id: str | None) -> list[ClientRow]:
        return [bad, good]

    monkeypatch.setattr(ap, "fetch_clients", fake_fetch_clients)
    monkeypatch.setattr(ap, "upsert_image_perf", AsyncMock(return_value=1))
    monkeypatch.setattr(ap, "upsert_video_perf", AsyncMock(return_value=0))

    async def fake_emit(_: Any) -> bool:
        return True

    monkeypatch.setattr(ap, "emit", fake_emit)

    report = asyncio.run(run_audit(format="image", window_days=7))
    assert report.clients_processed == 2  # both attempted
    assert report.rows_processed == 1  # only good produced rows
    assert any("Bad" in e or "bad" in e for e in report.errors)


def test_run_audit_tolerates_missing_ghl(monkeypatch: pytest.MonkeyPatch) -> None:
    """If GHL client init raises RuntimeError (no GHL_API_KEY), Meta-only run still works."""
    cls = [_client()]

    async def fake_fetch_clients(_: str | None) -> list[ClientRow]:
        return cls

    monkeypatch.setattr(ap, "fetch_clients", fake_fetch_clients)

    meta_instance = MagicMock()
    meta_instance.fetch_campaign_insights = AsyncMock(
        return_value=[_insight(campaign_id="cmp-A", leads=1, spend=10.0)]
    )
    meta_instance.__aenter__ = AsyncMock(return_value=meta_instance)
    meta_instance.__aexit__ = AsyncMock(return_value=None)
    monkeypatch.setattr(ap, "MetaAdsClient", MagicMock(return_value=meta_instance))

    # GHLClient ctor raises → orchestrator falls back to ghl_client = None.
    def _ghl_factory(*_a: Any, **_kw: Any) -> Any:
        raise RuntimeError("GHL_API_KEY must be set")

    monkeypatch.setattr(ap, "GHLClient", _ghl_factory)

    monkeypatch.setattr(ap, "upsert_image_perf", AsyncMock(return_value=1))
    monkeypatch.setattr(ap, "upsert_video_perf", AsyncMock(return_value=0))

    async def fake_emit(_: Any) -> bool:
        return True

    monkeypatch.setattr(ap, "emit", fake_emit)

    report = asyncio.run(run_audit(format="image", window_days=7))
    assert report.rows_processed == 1
    assert report.errors == []


def test_audit_report_to_dict_round_trips() -> None:
    r = AuditReport(
        format="image",
        window_days=7,
        clients_processed=1,
        rows_processed=5,
        rows_upserted=4,
        kills=2,
        notifications_emitted=2,
        errors=["x"],
    )
    d = r.to_dict()
    assert d["format"] == "image"
    assert d["rows_upserted"] == 4
    assert d["errors"] == ["x"]
