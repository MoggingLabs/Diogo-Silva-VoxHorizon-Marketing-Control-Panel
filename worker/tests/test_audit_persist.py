"""Tests for the campaign-perf upsert helpers.

We mock Supabase end-to-end and assert two things:

1. ``upsert_*_perf`` builds the right row payload — raw metrics plus a
   computed ``verdict`` and ``verdict_reason``.
2. The upsert is issued against the correct table with the daily unique
   index as the conflict target.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock

import pytest

from src.services import audit_persist as ap
from src.services.audit_persist import (
    IMAGE_DAILY_INDEX,
    VIDEO_DAILY_INDEX,
    ImagePerfRow,
    VideoPerfRow,
    upsert_image_perf,
    upsert_video_perf,
)


def _make_table_mock() -> MagicMock:
    """Chainable ``sb.table(name).upsert(rows, on_conflict=...).execute()``."""
    table = MagicMock(name="table")
    execute_result = MagicMock(name="execute_result")
    execute_result.data = [{"id": "row-1"}]
    table.upsert.return_value.execute.return_value = execute_result
    return table


@pytest.fixture
def mock_sb(monkeypatch: pytest.MonkeyPatch) -> tuple[MagicMock, dict[str, MagicMock]]:
    image_tbl = _make_table_mock()
    video_tbl = _make_table_mock()
    tables = {"campaign_perf_image": image_tbl, "campaign_perf_video": video_tbl}

    client = MagicMock(name="supabase_client")
    client.table.side_effect = lambda name: tables[name]

    monkeypatch.setattr(ap, "get_supabase_admin", lambda: client)
    return client, tables


# ---------------------------------------------------------------------------
# Image upsert
# ---------------------------------------------------------------------------


def _image_row(**overrides: Any) -> ImagePerfRow:
    base: dict[str, Any] = {
        "client_id": "cli-uuid",
        "campaign_id": "cmp-1",
        "window_days": 7,
        "spend": 50.0,
        "impressions": 1000,
        "clicks": 50,
        "ctr": 0.05,
        "leads_meta": 5,
        "leads_ghl": 0,
        "cpl_real": 10.0,
        "freq": 1.5,
        "cpl_target": 20.0,
        "days_since_launch": 7,
    }
    base.update(overrides)
    return ImagePerfRow(**base)


def test_upsert_image_perf_empty_list_is_a_noop(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    client, _ = mock_sb
    n = asyncio.run(upsert_image_perf([]))
    assert n == 0
    client.table.assert_not_called()


def test_upsert_image_perf_writes_to_image_table(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    client, _ = mock_sb
    asyncio.run(upsert_image_perf([_image_row()]))
    client.table.assert_called_once_with("campaign_perf_image")


def test_upsert_image_perf_uses_daily_index_as_conflict_target(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(upsert_image_perf([_image_row()]))
    kwargs = tables["campaign_perf_image"].upsert.call_args.kwargs
    assert kwargs.get("on_conflict") == IMAGE_DAILY_INDEX
    assert IMAGE_DAILY_INDEX == "campaign_perf_image_daily_uniq"


def test_upsert_image_perf_payload_includes_computed_verdict_keep(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    """Healthy row → verdict 'keep'."""
    _, tables = mock_sb
    asyncio.run(upsert_image_perf([_image_row(ctr=0.05, freq=1.5)]))
    payload = tables["campaign_perf_image"].upsert.call_args.args[0][0]
    assert payload["verdict"] == "keep"
    assert "strong" in payload["verdict_reason"].lower()
    # Sanity check the rest of the payload doesn't accidentally include
    # the helper-only fields cpl_target / days_since_launch.
    assert "cpl_target" not in payload
    assert "days_since_launch" not in payload


def test_upsert_image_perf_payload_includes_computed_verdict_kill(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    """$100 spent with zero leads → verdict 'kill'."""
    _, tables = mock_sb
    asyncio.run(
        upsert_image_perf(
            [_image_row(spend=100.0, leads_meta=0, leads_ghl=0)]
        )
    )
    payload = tables["campaign_perf_image"].upsert.call_args.args[0][0]
    assert payload["verdict"] == "kill"
    assert "zero leads" in payload["verdict_reason"]


def test_upsert_image_perf_payload_shape(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    """Pins the exact column set sent to Supabase."""
    _, tables = mock_sb
    asyncio.run(upsert_image_perf([_image_row()]))
    payload = tables["campaign_perf_image"].upsert.call_args.args[0][0]
    assert set(payload.keys()) == {
        "client_id",
        "campaign_id",
        "window_days",
        "spend",
        "impressions",
        "clicks",
        "ctr",
        "leads_meta",
        "leads_ghl",
        "cpl_real",
        "freq",
        "verdict",
        "verdict_reason",
    }


def test_upsert_image_perf_handles_batch(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    rows = [_image_row(campaign_id="a"), _image_row(campaign_id="b")]
    asyncio.run(upsert_image_perf(rows))
    payloads = tables["campaign_perf_image"].upsert.call_args.args[0]
    assert [p["campaign_id"] for p in payloads] == ["a", "b"]


# ---------------------------------------------------------------------------
# Video upsert
# ---------------------------------------------------------------------------


def _video_row(**overrides: Any) -> VideoPerfRow:
    base: dict[str, Any] = {
        "client_id": "cli-uuid",
        "campaign_id": "cmp-1",
        "window_days": 7,
        "spend": 50.0,
        "impressions": 1000,
        "clicks": 50,
        "ctr": 0.05,
        "leads_meta": 5,
        "leads_ghl": 0,
        "cpl_real": 10.0,
        "freq": 1.5,
        "cpl_target": 20.0,
        "days_since_launch": 7,
        "hook_rate": 0.50,
        "drop_off_3s": 0.30,
        "view_rate_avg": 0.55,
        "watch_time_p50": 12.0,
    }
    base.update(overrides)
    return VideoPerfRow(**base)


def test_upsert_video_perf_writes_to_video_table(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    client, _ = mock_sb
    asyncio.run(upsert_video_perf([_video_row()]))
    client.table.assert_called_once_with("campaign_perf_video")


def test_upsert_video_perf_uses_daily_index_as_conflict_target(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(upsert_video_perf([_video_row()]))
    kwargs = tables["campaign_perf_video"].upsert.call_args.kwargs
    assert kwargs.get("on_conflict") == VIDEO_DAILY_INDEX
    assert VIDEO_DAILY_INDEX == "campaign_perf_video_daily_uniq"


def test_upsert_video_perf_payload_includes_video_columns(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(upsert_video_perf([_video_row()]))
    payload = tables["campaign_perf_video"].upsert.call_args.args[0][0]
    for col in ("hook_rate", "drop_off_3s", "view_rate_avg", "watch_time_p50"):
        assert col in payload


def test_upsert_video_perf_kill_on_weak_hook_with_spend(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(
        upsert_video_perf(
            [_video_row(spend=100.0, hook_rate=0.10, leads_meta=2)]
        )
    )
    payload = tables["campaign_perf_video"].upsert.call_args.args[0][0]
    assert payload["verdict"] == "kill"
    assert "hook" in payload["verdict_reason"].lower()


def test_upsert_video_perf_payload_excludes_helper_only_fields(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    """cpl_target and days_since_launch are inputs to the verdict, not columns."""
    _, tables = mock_sb
    asyncio.run(upsert_video_perf([_video_row()]))
    payload = tables["campaign_perf_video"].upsert.call_args.args[0][0]
    assert "cpl_target" not in payload
    assert "days_since_launch" not in payload
