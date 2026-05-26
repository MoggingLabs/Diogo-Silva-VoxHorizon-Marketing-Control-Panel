"""Parity test: ``compute_pipeline_status`` matches the route-side reducer.

The PR-2 dual-write phase needs to be safe to merge: the routes will be
writing ``pipelines.status`` AND emitting ``stage_advanced`` events, and
the redesign assumes the DB reducer (``compute_pipeline_status``) returns
the SAME value the route would have written. This test proves the
contract over a corpus of synthetic event sequences -- any drift between
``compute_pipeline_status(id)`` and the expected pipeline_status_enum
fails CI before PR-2 can ship.

Algorithm under test (closed-form, lifted from the migration's docstring):
  1. ``pipeline_cancelled`` event present -> 'cancelled'.
  2. else the stage of the most recent ``stage_advanced`` event.
  3. else (empty timeline) -> 'configuration' (default).
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest


pytestmark = pytest.mark.integration


@dataclass(frozen=True)
class EventSpec:
    kind: str
    stage: str | None = None


@dataclass(frozen=True)
class Scenario:
    name: str
    events: list[EventSpec]
    expected: str


# A corpus that hits every branch of the reducer + a representative slice
# of the realistic event sequences a route would emit. Each entry is one
# (event sequence -> derived status) parity check.
_SCENARIOS = [
    Scenario(name="empty", events=[], expected="configuration"),
    Scenario(
        name="single_advance",
        events=[EventSpec("stage_advanced", "ideation")],
        expected="ideation",
    ),
    Scenario(
        name="multiple_advances_latest_wins",
        events=[
            EventSpec("stage_advanced", "configuration"),
            EventSpec("stage_advanced", "ideation"),
            EventSpec("stage_advanced", "generation"),
        ],
        expected="generation",
    ),
    Scenario(
        name="cancel_overrides_all",
        events=[
            EventSpec("stage_advanced", "ideation"),
            EventSpec("stage_advanced", "generation"),
            EventSpec("pipeline_cancelled"),
        ],
        expected="cancelled",
    ),
    Scenario(
        name="cancel_before_subsequent_advance_still_wins",
        events=[
            EventSpec("stage_advanced", "ideation"),
            EventSpec("pipeline_cancelled"),
            EventSpec("stage_advanced", "generation"),
        ],
        expected="cancelled",
    ),
    Scenario(
        name="operator_events_dont_advance",
        events=[
            EventSpec("operator_dispatched", "configuration"),
            EventSpec("operator_running", "configuration"),
            EventSpec("operator_completed", "configuration"),
        ],
        expected="configuration",
    ),
    Scenario(
        name="task_events_dont_advance",
        events=[
            EventSpec("task_queued", "ideation"),
            EventSpec("task_done", "ideation"),
        ],
        expected="configuration",
    ),
    Scenario(
        name="advance_after_operator_complete",
        events=[
            EventSpec("operator_dispatched", "configuration"),
            EventSpec("operator_completed", "configuration"),
            EventSpec("stage_advanced", "ideation"),
        ],
        expected="ideation",
    ),
    Scenario(
        name="stage_advanced_with_null_stage_ignored",
        events=[
            EventSpec("stage_advanced", "ideation"),
            EventSpec("stage_advanced", None),
        ],
        expected="ideation",
    ),
    Scenario(
        name="full_pipeline_journey",
        events=[
            EventSpec("stage_advanced", "configuration"),
            EventSpec("stage_advanced", "ideation"),
            EventSpec("stage_advanced", "review"),
            EventSpec("stage_advanced", "generation"),
            EventSpec("stage_advanced", "creative_qa"),
            EventSpec("stage_advanced", "compliance_review"),
            EventSpec("stage_advanced", "copy"),
            EventSpec("stage_advanced", "spec_validation"),
            EventSpec("stage_advanced", "variant_plan"),
            EventSpec("stage_advanced", "finalize_assets"),
            EventSpec("stage_advanced", "launch_handoff"),
            EventSpec("stage_advanced", "monitor"),
        ],
        expected="monitor",
    ),
]


def _seed_pipeline(cur) -> str:
    cur.execute(
        """
        insert into clients (slug, name, service_type)
        values ('par-' || substr(md5(random()::text), 1, 8),
                'Parity Test', 'roofing')
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


def _emit(cur, *, pipeline_id: str, spec: EventSpec) -> None:
    cur.execute(
        """
        insert into pipeline_events (pipeline_id, kind, stage, payload)
        values (%s, %s, %s::pipeline_status_enum, '{}'::jsonb)
        """,
        (pipeline_id, spec.kind, spec.stage),
    )


@pytest.mark.parametrize("scenario", _SCENARIOS, ids=[s.name for s in _SCENARIOS])
def test_reducer_matches_expected_status(db_conn, scenario: Scenario) -> None:
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        for spec in scenario.events:
            _emit(cur, pipeline_id=pipeline_id, spec=spec)
        cur.execute(
            "select compute_pipeline_status(%s)", (pipeline_id,)
        )
        assert cur.fetchone()[0] == scenario.expected, (
            f"{scenario.name}: expected {scenario.expected!r}"
        )
