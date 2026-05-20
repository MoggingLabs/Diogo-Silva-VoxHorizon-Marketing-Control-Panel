"""Tests for atomic video creative + iteration + event inserts.

Mirrors ``test_atomic_inserts.py`` (image side); the goal is the same shape
of confidence: the function writes three rows per call, in order, with the
right payload — for both the "first stage (insert)" and "later stage
(update)" cases.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock

import pytest

from src.services import atomic_inserts_video as ai
from src.services.atomic_inserts_video import (
    STAGE_STATUS,
    VideoStageResult,
    record_video_stage,
)


def _make_insert_table_mock(returned_id: str) -> MagicMock:
    """`sb.table(...).insert(...).execute().data[0]` returns `{"id": returned_id}`."""
    table = MagicMock(name="insert_table")
    execute = MagicMock(name="insert_execute_result")
    execute.data = [{"id": returned_id}]
    table.insert.return_value.execute.return_value = execute
    # Default `.update(...).eq(...).execute()` chain returns nothing —
    # tests that rely on update build their own mock for that case.
    return table


def _make_update_table_mock(returned_id: str) -> MagicMock:
    """`sb.table(...).update(...).eq(...).execute().data[0]` returns `{"id": ...}`."""
    table = MagicMock(name="update_table")
    execute = MagicMock(name="update_execute_result")
    execute.data = [{"id": returned_id}]
    table.update.return_value.eq.return_value.execute.return_value = execute
    return table


def _make_table_mock_both(returned_id: str) -> MagicMock:
    """Table mock that responds to both `.insert(...)` and `.update(...).eq(...)`."""
    table = MagicMock(name="table")
    insert_execute = MagicMock(name="insert_execute_result")
    insert_execute.data = [{"id": returned_id}]
    table.insert.return_value.execute.return_value = insert_execute
    update_execute = MagicMock(name="update_execute_result")
    update_execute.data = [{"id": returned_id}]
    table.update.return_value.eq.return_value.execute.return_value = update_execute
    return table


@pytest.fixture
def mock_sb(monkeypatch: pytest.MonkeyPatch) -> tuple[MagicMock, dict[str, MagicMock]]:
    """Return (client_mock, table_mocks_by_name).

    Each table records the payloads passed to ``.insert`` / ``.update`` so
    tests can assert on the exact shape sent to Supabase.
    """
    creatives_tbl = _make_table_mock_both("vc-id")
    iterations_tbl = _make_insert_table_mock("vi-id")
    events_tbl = _make_insert_table_mock("ev-id")

    tables: dict[str, MagicMock] = {
        "video_creatives": creatives_tbl,
        "video_iterations": iterations_tbl,
        "events": events_tbl,
    }

    client = MagicMock(name="supabase_client")
    client.table.side_effect = lambda name: tables[name]

    monkeypatch.setattr(ai, "get_supabase_admin", lambda: client)
    return client, tables


def _insert_payload(table_mock: MagicMock) -> dict[str, Any]:
    return table_mock.insert.call_args.args[0]


def _update_payload(table_mock: MagicMock) -> dict[str, Any]:
    return table_mock.update.call_args.args[0]


def _update_eq(table_mock: MagicMock) -> tuple[str, Any]:
    """The `(column, value)` passed to `.eq(...)` after `.update(...)`."""
    return table_mock.update.return_value.eq.call_args.args  # type: ignore[no-any-return]


# ---------------------------------------------------------------------------
# First-stage call: inserts the row.
# ---------------------------------------------------------------------------


def test_first_stage_inserts_creative_and_returns_ids(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    result = asyncio.run(
        record_video_stage(
            brief_id="brief-1",
            stage="script",
            paths={"script_path": "brief-1/v1/script.json"},
            iteration_kind="generate_script",
        )
    )
    assert isinstance(result, VideoStageResult)
    assert result.creative_id == "vc-id"
    assert result.iteration_id == "vi-id"
    assert result.event_id == "ev-id"
    assert result.status == "script_ready"
    assert result.new_creative is True


def test_first_stage_creative_payload_shape(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(
        record_video_stage(
            brief_id="brief-1",
            stage="script",
            paths={"script_path": "brief-1/v1/script.json"},
            iteration_kind="generate_script",
        )
    )
    payload = _insert_payload(tables["video_creatives"])
    assert payload == {
        "brief_id": "brief-1",
        "status": "script_ready",
        "script_path": "brief-1/v1/script.json",
    }


def test_unknown_path_keys_are_dropped(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(
        record_video_stage(
            brief_id="brief-1",
            stage="script",
            paths={
                "script_path": "brief-1/v1/script.json",
                "bogus_column": "should-be-dropped",
            },
            iteration_kind="generate_script",
        )
    )
    payload = _insert_payload(tables["video_creatives"])
    assert "bogus_column" not in payload
    assert payload["script_path"] == "brief-1/v1/script.json"


# ---------------------------------------------------------------------------
# Later-stage call: patches an existing row instead of inserting.
# ---------------------------------------------------------------------------


def test_later_stage_updates_existing_creative(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    result = asyncio.run(
        record_video_stage(
            brief_id="brief-1",
            stage="voiceover",
            paths={"voiceover_path": "brief-1/v1/voiceover.mp3"},
            iteration_kind="regenerate_voiceover",
            creative_id="existing-vc-id",
        )
    )
    payload = _update_payload(tables["video_creatives"])
    assert payload == {
        "status": "voiceover_ready",
        "voiceover_path": "brief-1/v1/voiceover.mp3",
    }
    # The .eq("id", existing-vc-id) call scoped the update.
    column, value = _update_eq(tables["video_creatives"])
    assert column == "id"
    assert value == "existing-vc-id"
    assert result.new_creative is False
    assert result.status == "voiceover_ready"
    # No insert should have been issued on the creatives table.
    tables["video_creatives"].insert.assert_not_called()


def test_broll_clips_round_trip_as_jsonb(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    clips = [
        {
            "segment_idx": 0,
            "store_backend": "local",
            "clip_id": "clip-a",
            "in_s": 0.0,
            "out_s": 4.5,
            "source_url": "file:///broll/clip-a.mp4",
        }
    ]
    asyncio.run(
        record_video_stage(
            brief_id="brief-1",
            stage="broll_pick",
            paths={"broll_clips": clips},
            iteration_kind="swap_broll",
            creative_id="vc-1",
        )
    )
    payload = _update_payload(tables["video_creatives"])
    assert payload == {
        "status": "broll_ready",
        "broll_clips": clips,
    }


# ---------------------------------------------------------------------------
# Iteration + event rows are appended regardless of insert/update path.
# ---------------------------------------------------------------------------


def test_iteration_payload_shape(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(
        record_video_stage(
            brief_id="brief-1",
            stage="voiceover",
            paths={"voiceover_path": "v.mp3"},
            iteration_kind="regenerate_voiceover",
            iteration_content={"voice_id": "rachel", "version": 2},
            author="user",
            parent_creative_id="parent-vc",
            creative_id="vc-1",
        )
    )
    payload = _insert_payload(tables["video_iterations"])
    # creative_id is taken from the updated row's returned id (the mock
    # returns "vc-id" for both insert + update on the creatives table).
    assert payload == {
        "creative_id": "vc-id",
        "parent_creative_id": "parent-vc",
        "author": "user",
        "kind": "regenerate_voiceover",
        "content": {"voice_id": "rachel", "version": 2},
    }


def test_iteration_content_defaults_to_paths_dict(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(
        record_video_stage(
            brief_id="brief-1",
            stage="script",
            paths={"script_path": "p.json"},
            iteration_kind="generate_script",
        )
    )
    payload = _insert_payload(tables["video_iterations"])
    assert payload["content"] == {"paths": {"script_path": "p.json"}}


def test_event_payload_shape(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(
        record_video_stage(
            brief_id="brief-1",
            stage="captioned",
            paths={"captioned_path": "out.mp4"},
            iteration_kind="recaption",
            creative_id="vc-1",
        )
    )
    payload = _insert_payload(tables["events"])
    assert payload == {
        "kind": "video_recaption",
        "ref_table": "video_creatives",
        "ref_id": "vc-id",
        "payload": {
            "brief_id": "brief-1",
            "stage": "captioned",
            "status": "captioned",
        },
    }


def test_event_kind_reflects_iteration_kind(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    _, tables = mock_sb
    asyncio.run(
        record_video_stage(
            brief_id="brief-1",
            stage="script",
            paths={"script_path": "p.json"},
            iteration_kind="user_edit",
        )
    )
    assert _insert_payload(tables["events"])["kind"] == "video_user_edit"


# ---------------------------------------------------------------------------
# Order matters: video_creatives first (insert or update), then iterations,
# then events. Matches the image-side guarantee.
# ---------------------------------------------------------------------------


def test_writes_happen_in_order_first_stage(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    client, _ = mock_sb
    asyncio.run(
        record_video_stage(
            brief_id="brief-1",
            stage="script",
            paths={"script_path": "p.json"},
            iteration_kind="generate_script",
        )
    )
    table_names = [call.args[0] for call in client.table.call_args_list]
    assert table_names == ["video_creatives", "video_iterations", "events"]


def test_writes_happen_in_order_later_stage(
    mock_sb: tuple[MagicMock, dict[str, MagicMock]],
) -> None:
    client, _ = mock_sb
    asyncio.run(
        record_video_stage(
            brief_id="brief-1",
            stage="composed",
            paths={"composed_path": "v.mp4"},
            iteration_kind="rerender",
            creative_id="vc-1",
        )
    )
    table_names = [call.args[0] for call in client.table.call_args_list]
    assert table_names == ["video_creatives", "video_iterations", "events"]


def test_stage_status_table_matches_enum() -> None:
    """Sanity check the stage→status table stays in sync with the schema enum."""
    expected = {
        "script": "script_ready",
        "voiceover": "voiceover_ready",
        "broll_search": "broll_ready",
        "broll_pick": "broll_ready",
        "composed": "composed",
        "captioned": "captioned",
    }
    assert STAGE_STATUS == expected
