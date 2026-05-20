"""Tests for atomic creative + iteration + event inserts."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock

import pytest

from src.services import atomic_inserts as ai
from src.services.atomic_inserts import (
    CreativeInsertResult,
    record_creative_stage,
)


def _make_table_mock(returned_id: str) -> MagicMock:
    """Build a chainable mock that mimics ``sb.table(...).insert(...).execute().data[0]``."""
    table = MagicMock(name="table")
    execute = MagicMock(name="execute_result")
    execute.data = [{"id": returned_id}]
    table.insert.return_value.execute.return_value = execute
    return table


@pytest.fixture
def mock_sb(monkeypatch: pytest.MonkeyPatch) -> tuple[MagicMock, dict[str, MagicMock]]:
    """Return (client_mock, table_mocks_by_name).

    Each table's mock records the payload passed to `.insert(...)` so tests
    can assert on the exact shape sent to Supabase.
    """
    creatives_tbl = _make_table_mock("c-id")
    iterations_tbl = _make_table_mock("i-id")
    events_tbl = _make_table_mock("e-id")

    tables: dict[str, MagicMock] = {
        "creatives": creatives_tbl,
        "creative_iterations": iterations_tbl,
        "events": events_tbl,
    }

    client = MagicMock(name="supabase_client")
    client.table.side_effect = lambda name: tables[name]

    monkeypatch.setattr(ai, "get_supabase_admin", lambda: client)
    return client, tables


def _payload_of(table_mock: MagicMock) -> dict[str, Any]:
    """Pull the dict that was passed to `.insert(...)` on a table mock."""
    return table_mock.insert.call_args.args[0]


def test_record_creative_stage_returns_all_three_ids(mock_sb: tuple[MagicMock, dict[str, MagicMock]]) -> None:
    result = asyncio.run(
        record_creative_stage(
            brief_id="brief-1",
            file_path_supabase="brief-1/sunny-1x1-v1.0.png",
            concept="Sunny",
            offer_text="$99 inspection",
            ratio="1x1",
            version="v1.0",
            prompt_used={"model": "kie-flux", "prompt": "a sunny roof"},
        )
    )
    assert isinstance(result, CreativeInsertResult)
    assert result.creative_id == "c-id"
    assert result.iteration_id == "i-id"
    assert result.event_id == "e-id"


def test_record_creative_stage_inserts_creative_row_shape(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(
        record_creative_stage(
            brief_id="brief-1",
            file_path_supabase="brief-1/sunny-1x1-v1.0.png",
            concept="Sunny",
            offer_text="$99 inspection",
            ratio="1x1",
            version="v1.0",
            prompt_used={"model": "kie-flux"},
        )
    )
    payload = _payload_of(tables["creatives"])
    assert payload == {
        "brief_id": "brief-1",
        "type": "image",
        "concept": "Sunny",
        "offer_text": "$99 inspection",
        "ratio": "1x1",
        "version": "v1.0",
        "file_path_supabase": "brief-1/sunny-1x1-v1.0.png",
        "prompt_used": {"model": "kie-flux"},
        "status": "draft",
    }


def test_record_creative_stage_inserts_iteration_row_shape(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(
        record_creative_stage(
            brief_id="brief-1",
            file_path_supabase="brief-1/sunny-1x1-v1.0.png",
            concept="Sunny",
            offer_text=None,
            ratio="9x16",
            version="v1.0",
            prompt_used={"model": "kie-flux"},
            iteration_kind="regenerate",
            iteration_content={"notes": "more saturation"},
            author="user",
            parent_creative_id="parent-uuid",
        )
    )
    payload = _payload_of(tables["creative_iterations"])
    assert payload == {
        "creative_id": "c-id",
        "parent_creative_id": "parent-uuid",
        "author": "user",
        "kind": "regenerate",
        "content": {"notes": "more saturation"},
        "image_path_supabase": "brief-1/sunny-1x1-v1.0.png",
    }


def test_iteration_content_defaults_to_prompt_used(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(
        record_creative_stage(
            brief_id="brief-1",
            file_path_supabase="path.png",
            concept="c",
            offer_text=None,
            ratio="1x1",
            version="v1.0",
            prompt_used={"model": "kie-flux"},
        )
    )
    payload = _payload_of(tables["creative_iterations"])
    assert payload["content"] == {"prompt": {"model": "kie-flux"}}


def test_record_creative_stage_inserts_event_row_shape(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(
        record_creative_stage(
            brief_id="brief-1",
            file_path_supabase="brief-1/sunny-1x1-v1.0.png",
            concept="Sunny",
            offer_text=None,
            ratio="1x1",
            version="v1.0",
            prompt_used={"model": "kie-flux"},
        )
    )
    payload = _payload_of(tables["events"])
    assert payload == {
        "kind": "creative_generate",
        "ref_table": "creatives",
        "ref_id": "c-id",
        "payload": {
            "brief_id": "brief-1",
            "version": "v1.0",
            "ratio": "1x1",
        },
    }


def test_event_kind_reflects_iteration_kind(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(
        record_creative_stage(
            brief_id="b",
            file_path_supabase="p.png",
            concept="c",
            offer_text=None,
            ratio="1x1",
            version="v1.0",
            prompt_used={},
            iteration_kind="user_edit",
        )
    )
    assert _payload_of(tables["events"])["kind"] == "creative_user_edit"


def test_inserts_happen_in_order(mock_sb: tuple[MagicMock, dict[str, MagicMock]]) -> None:
    client, tables = mock_sb
    asyncio.run(
        record_creative_stage(
            brief_id="b",
            file_path_supabase="p.png",
            concept="c",
            offer_text=None,
            ratio="1x1",
            version="v1.0",
            prompt_used={},
        )
    )
    # `sb.table(name)` was called for each table in order.
    table_calls = [call.args[0] for call in client.table.call_args_list]
    assert table_calls == ["creatives", "creative_iterations", "events"]
