"""DB-backed tests for the ``compute_pipeline_status`` reducer.

The reducer is the redesign's anti-drift cure: ``pipelines.status`` becomes
DERIVED from ``pipeline_events`` instead of stored. These tests pin every
branch of the algorithm:

  1. ``pipeline_cancelled`` event present -> always 'cancelled' (terminal
     escape, beats every later stage_advanced).
  2. else the ``stage`` of the most recent ``stage_advanced`` event.
  3. else (empty timeline) -> 'configuration' (a fresh pipeline).
"""

from __future__ import annotations

import pytest


pytestmark = pytest.mark.integration


def _seed_pipeline(cur) -> str:
    cur.execute(
        """
        insert into clients (slug, name, service_type)
        values ('red-' || substr(md5(random()::text), 1, 8),
                'Reducer Test', 'roofing')
        returning id
        """
    )
    client_id = cur.fetchone()[0]
    cur.execute(
        """
        insert into pipelines (format_choice, client_id)
        values ('image', %s)
        returning id
        """,
        (client_id,),
    )
    return str(cur.fetchone()[0])


def _emit(cur, *, pipeline_id: str, kind: str, stage: str | None = None) -> None:
    cur.execute(
        """
        insert into pipeline_events (pipeline_id, kind, stage, payload)
        values (%s, %s, %s::pipeline_status_enum, '{}'::jsonb)
        """,
        (pipeline_id, kind, stage),
    )


def test_empty_timeline_returns_configuration(db_conn) -> None:
    """A pipeline with no events derives status='configuration' (fresh)."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        cur.execute(
            "select compute_pipeline_status(%s)", (pipeline_id,)
        )
        assert cur.fetchone()[0] == "configuration"


def test_latest_stage_advanced_wins(db_conn) -> None:
    """The reducer returns the ``stage`` of the newest stage_advanced."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        _emit(cur, pipeline_id=pipeline_id, kind="stage_advanced", stage="ideation")
        _emit(cur, pipeline_id=pipeline_id, kind="stage_advanced", stage="generation")
        cur.execute(
            "select compute_pipeline_status(%s)", (pipeline_id,)
        )
        assert cur.fetchone()[0] == "generation"


def test_pipeline_cancelled_overrides_advances(db_conn) -> None:
    """A ``pipeline_cancelled`` event short-circuits regardless of stage."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        _emit(cur, pipeline_id=pipeline_id, kind="stage_advanced", stage="generation")
        _emit(cur, pipeline_id=pipeline_id, kind="pipeline_cancelled")
        cur.execute(
            "select compute_pipeline_status(%s)", (pipeline_id,)
        )
        assert cur.fetchone()[0] == "cancelled"


def test_stage_advanced_without_stage_ignored(db_conn) -> None:
    """A ``stage_advanced`` row with NULL stage doesn't move the reducer."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        _emit(cur, pipeline_id=pipeline_id, kind="stage_advanced", stage="ideation")
        # A defective event with no stage -- should not become the latest.
        _emit(cur, pipeline_id=pipeline_id, kind="stage_advanced", stage=None)
        cur.execute(
            "select compute_pipeline_status(%s)", (pipeline_id,)
        )
        assert cur.fetchone()[0] == "ideation"


def test_other_event_kinds_dont_move_reducer(db_conn) -> None:
    """Operator transition events (operator_dispatched / *_running / *_completed)
    don't advance status; only ``stage_advanced`` does."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        _emit(cur, pipeline_id=pipeline_id, kind="operator_dispatched", stage="configuration")
        _emit(cur, pipeline_id=pipeline_id, kind="operator_running", stage="configuration")
        _emit(cur, pipeline_id=pipeline_id, kind="operator_completed", stage="configuration")
        cur.execute(
            "select compute_pipeline_status(%s)", (pipeline_id,)
        )
        # Still 'configuration' (the default, no stage_advanced has fired).
        assert cur.fetchone()[0] == "configuration"
