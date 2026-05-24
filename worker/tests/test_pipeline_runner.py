"""Direct unit tests for :mod:`worker.src.services.pipeline_runner`.

The route-level tests in ``test_pipeline_route.py`` exercise the happy
paths via the FastAPI TestClient; this module focuses on the leaf
helpers and corner cases the route tests don't reach:

* ``emit_pipeline_event`` — exception swallowing on Supabase failure,
  None return when ``data`` is empty.
* ``fetch_stage_events`` — every ``kind`` branch including
  ``task_error`` counting and the ``open_count == 0`` short-circuit
  when ``done + err`` balances ``queued + running``.
* ``picks_from_pipeline`` — non-dict and missing-keys defensive paths.
* ``fetch_pipeline`` — both ``isinstance(row, dict)`` outcomes.
* ``emit_cost`` — ``task_event_id`` + ``extra`` are forwarded correctly.
* ``ideation_already_ran`` / ``generation_state`` glue.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from src.services import pipeline_runner as pr


# ---------------------------------------------------------------------------
# Fake supabase client mirroring just what pipeline_runner touches
# ---------------------------------------------------------------------------


class _FakeTable:
    def __init__(self, name: str, parent: "_FakeSupabase") -> None:
        self.name = name
        self.parent = parent
        self._select: str | None = None
        self._insert: dict | None = None
        self._eqs: list[tuple[str, str]] = []
        self._gt: tuple[str, str] | None = None
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None

    def select(self, cols: str) -> "_FakeTable":
        self._select = cols
        return self

    def insert(self, data: dict) -> "_FakeTable":
        self._insert = data
        return self

    def eq(self, col: str, val: str) -> "_FakeTable":
        self._eqs.append((col, val))
        return self

    def gt(self, col: str, val: str) -> "_FakeTable":
        self._gt = (col, val)
        return self

    def order(self, col: str, *, desc: bool = False) -> "_FakeTable":
        self._order = (col, desc)
        return self

    def limit(self, n: int) -> "_FakeTable":
        self._limit = n
        return self

    def maybe_single(self) -> "_FakeTable":
        return self

    def execute(self) -> SimpleNamespace:
        if self.parent.raise_on_execute:
            raise RuntimeError("supabase blew up")
        if self.parent.execute_returns_none:
            # supabase-py returns None (not a response) from
            # maybe_single().execute() when no row matches.
            return None  # type: ignore[return-value]

        if self._insert is not None:
            self.parent.inserts.append((self.name, dict(self._insert)))
            # Inserts return the row(s) with a fake id (mirrors supabase-py).
            row = {**self._insert, "id": f"new-id-{len(self.parent.inserts)}"}
            return SimpleNamespace(data=[row])

        # Read paths
        if self.name == "pipelines":
            return SimpleNamespace(data=self.parent.pipeline_row)
        if self.name == "pipeline_work_units":
            # Durable closure ledger (migration 0019). Honour the
            # (pipeline_id, stage) equality filters fetch_work_unit_state sets.
            # Non-dict rows pass through unfiltered so the helper's own
            # isinstance() guard is exercised (mirrors a stray REST row).
            rows = list(self.parent.work_units)
            for col, val in self._eqs:
                rows = [
                    r for r in rows if not isinstance(r, dict) or r.get(col) == val
                ]
            return SimpleNamespace(data=rows)
        if self.name == "pipeline_events":
            # Mimic the two-query strategy: most-recent stage_advanced
            # then "events since cutoff". The caller passes a kind filter
            # for the first call but not for the second.
            rows = list(self.parent.events)
            for col, val in self._eqs:
                rows = [r for r in rows if r.get(col) == val]
            if self._gt is not None:
                col, val = self._gt
                rows = [r for r in rows if str(r.get(col, "")) > val]
            if self._order:
                col, desc = self._order
                rows.sort(key=lambda r: r.get(col, ""), reverse=desc)
            if self._limit:
                rows = rows[: self._limit]
            return SimpleNamespace(data=rows)
        return SimpleNamespace(data=None)


class _FakeSupabase:
    def __init__(self) -> None:
        self.events: list[dict] = []
        self.pipeline_row: dict | None = None
        self.work_units: list[dict] = []
        self.inserts: list[tuple[str, dict]] = []
        self.raise_on_execute: bool = False
        self.execute_returns_none: bool = False

    def table(self, name: str) -> _FakeTable:
        return _FakeTable(name, self)


@pytest.fixture
def fake_sb(monkeypatch: pytest.MonkeyPatch) -> _FakeSupabase:
    sb = _FakeSupabase()
    monkeypatch.setattr(pr, "get_supabase_admin", lambda: sb)
    return sb


# ---------------------------------------------------------------------------
# emit_pipeline_event
# ---------------------------------------------------------------------------


def test_emit_pipeline_event_returns_inserted_id(fake_sb: _FakeSupabase) -> None:
    event_id = pr.emit_pipeline_event(
        pipeline_id="p-1",
        kind=pr.EVENT_TASK_DONE,
        stage="ideation",
        payload={"creative_id": "c-1"},
    )
    assert event_id is not None
    assert len(fake_sb.inserts) == 1
    name, row = fake_sb.inserts[0]
    assert name == "pipeline_events"
    assert row["pipeline_id"] == "p-1"
    assert row["kind"] == pr.EVENT_TASK_DONE
    assert row["stage"] == "ideation"
    assert row["payload"] == {"creative_id": "c-1"}
    # Migration 0008 added a NOT-NULL `source` discriminator; the worker
    # stamps it explicitly so the dashboard can tell its emissions apart
    # from the Hermes hook/task emitters.
    assert row["source"] == "worker"


def test_emit_pipeline_event_defaults_payload_to_empty_dict(
    fake_sb: _FakeSupabase,
) -> None:
    pr.emit_pipeline_event(
        pipeline_id="p-2",
        kind=pr.EVENT_STAGE_ADVANCED,
        stage="generation",
    )
    _, row = fake_sb.inserts[0]
    assert row["payload"] == {}


def test_emit_pipeline_event_swallows_supabase_errors(
    fake_sb: _FakeSupabase,
) -> None:
    """A timeline-insert failure must NOT raise — the timeline is an
    audit log, not authoritative. The helper returns ``None`` so the
    caller can skip follow-up events (e.g. cost_recorded)."""
    fake_sb.raise_on_execute = True

    event_id = pr.emit_pipeline_event(
        pipeline_id="p-3",
        kind=pr.EVENT_TASK_RUNNING,
        stage="ideation",
        payload=None,
    )
    assert event_id is None


def test_emit_pipeline_event_returns_none_when_data_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If Supabase returns ``data=None`` or an empty list the helper
    must return ``None`` rather than crashing on indexing."""

    class _EmptyTable:
        def insert(self, _: dict) -> "_EmptyTable":
            return self

        def execute(self) -> SimpleNamespace:
            return SimpleNamespace(data=None)

    class _EmptySb:
        def table(self, _: str) -> _EmptyTable:
            return _EmptyTable()

    monkeypatch.setattr(pr, "get_supabase_admin", lambda: _EmptySb())
    assert (
        pr.emit_pipeline_event(
            pipeline_id="p-4",
            kind=pr.EVENT_TASK_QUEUED,
            stage="ideation",
        )
        is None
    )


def test_emit_pipeline_event_returns_none_when_row_lacks_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A row that doesn't contain an ``id`` should yield ``None`` so the
    follow-up event helpers don't reference a bogus task_event_id."""

    class _NoIdTable:
        def insert(self, _: dict) -> "_NoIdTable":
            return self

        def execute(self) -> SimpleNamespace:
            return SimpleNamespace(data=[{"kind": "task_done"}])

    class _NoIdSb:
        def table(self, _: str) -> _NoIdTable:
            return _NoIdTable()

    monkeypatch.setattr(pr, "get_supabase_admin", lambda: _NoIdSb())
    assert (
        pr.emit_pipeline_event(
            pipeline_id="p-5",
            kind=pr.EVENT_TASK_QUEUED,
            stage="ideation",
        )
        is None
    )


# ---------------------------------------------------------------------------
# fetch_stage_events
# ---------------------------------------------------------------------------


def test_fetch_stage_events_returns_empty_when_stage_never_entered(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.events = []
    snap = pr.fetch_stage_events(pipeline_id="p-x", stage="ideation")
    assert snap.stage_advanced_at is None
    assert snap.non_terminal_task_kinds == []
    assert snap.task_done_count == 0
    assert snap.task_error_count == 0
    assert snap.any_task_event is False


def _event(pipeline_id: str, **fields: Any) -> dict:
    return {"pipeline_id": pipeline_id, **fields}


def test_fetch_stage_events_counts_terminals_and_errors(
    fake_sb: _FakeSupabase,
) -> None:
    """Exercises the ``task_error`` branch (lines 209-210)."""
    fake_sb.events = [
        _event(
            "p",
            id="e0",
            kind="stage_advanced",
            stage="generation",
            created_at="2025-01-01T00:00:00Z",
        ),
        _event(
            "p",
            id="e1",
            kind="task_queued",
            stage="generation",
            created_at="2025-01-01T00:00:01Z",
        ),
        _event(
            "p",
            id="e2",
            kind="task_running",
            stage="generation",
            created_at="2025-01-01T00:00:02Z",
        ),
        _event(
            "p",
            id="e3",
            kind="task_done",
            stage="generation",
            created_at="2025-01-01T00:00:03Z",
        ),
        _event(
            "p",
            id="e4",
            kind="task_error",
            stage="generation",
            created_at="2025-01-01T00:00:04Z",
        ),
    ]

    snap = pr.fetch_stage_events(pipeline_id="p", stage="generation")
    assert snap.stage_advanced_at == "2025-01-01T00:00:00Z"
    assert snap.task_done_count == 1
    assert snap.task_error_count == 1
    assert snap.any_task_event is True
    # queued+running == done+err → no open work.
    assert snap.non_terminal_task_kinds == []


def test_fetch_stage_events_non_terminal_kinds_when_running_outpaces(
    fake_sb: _FakeSupabase,
) -> None:
    """When more runnings than dones/errors land, that kind shows up
    in ``non_terminal_task_kinds``."""
    fake_sb.events = [
        _event(
            "p",
            id="e0",
            kind="stage_advanced",
            stage="generation",
            created_at="2025-01-01T00:00:00Z",
        ),
        _event(
            "p",
            id="e1",
            kind="task_queued",
            stage="generation",
            created_at="2025-01-01T00:00:01Z",
        ),
        _event(
            "p",
            id="e2",
            kind="task_running",
            stage="generation",
            created_at="2025-01-01T00:00:02Z",
        ),
        _event(
            "p",
            id="e3",
            kind="task_running",
            stage="generation",
            created_at="2025-01-01T00:00:03Z",
        ),
    ]
    snap = pr.fetch_stage_events(pipeline_id="p", stage="generation")
    # 1 queued + 2 running vs 0 terminals: both non-terminal kinds surface.
    assert "task_running" in snap.non_terminal_task_kinds
    assert "task_queued" in snap.non_terminal_task_kinds


def test_fetch_stage_events_ignores_unrelated_kinds(
    fake_sb: _FakeSupabase,
) -> None:
    """Non-task events (e.g. ``cost_recorded``) don't bump task_done/error
    nor flip ``any_task_event``."""
    fake_sb.events = [
        _event(
            "p",
            id="e0",
            kind="stage_advanced",
            stage="ideation",
            created_at="2025-01-01T00:00:00Z",
        ),
        _event(
            "p",
            id="e1",
            kind="cost_recorded",
            stage="ideation",
            created_at="2025-01-01T00:00:01Z",
        ),
    ]
    snap = pr.fetch_stage_events(pipeline_id="p", stage="ideation")
    assert snap.any_task_event is False
    assert snap.task_done_count == 0
    assert snap.task_error_count == 0


# ---------------------------------------------------------------------------
# ideation_already_ran / generation_state glue
# ---------------------------------------------------------------------------


def test_ideation_already_ran_false_without_events(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.events = []
    assert pr.ideation_already_ran("p") is False


def test_ideation_already_ran_true_after_any_task_event(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.events = [
        _event(
            "p",
            id="e0",
            kind="stage_advanced",
            stage="ideation",
            created_at="2025-01-01T00:00:00Z",
        ),
        _event(
            "p",
            id="e1",
            kind="task_done",
            stage="ideation",
            created_at="2025-01-01T00:00:01Z",
        ),
    ]
    assert pr.ideation_already_ran("p") is True


def test_generation_state_running_when_open_tasks(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.events = [
        _event(
            "p",
            id="e0",
            kind="stage_advanced",
            stage="generation",
            created_at="2025-01-01T00:00:00Z",
        ),
        _event(
            "p",
            id="e1",
            kind="task_running",
            stage="generation",
            created_at="2025-01-01T00:00:01Z",
        ),
    ]
    s = pr.generation_state("p")
    assert s.already_running is True
    assert s.already_complete is False
    assert s.started_at == "2025-01-01T00:00:00Z"


def test_generation_state_complete_when_all_terminal(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.events = [
        _event(
            "p",
            id="e0",
            kind="stage_advanced",
            stage="generation",
            created_at="2025-01-01T00:00:00Z",
        ),
        _event(
            "p",
            id="e1",
            kind="task_done",
            stage="generation",
            created_at="2025-01-01T00:00:01Z",
        ),
    ]
    s = pr.generation_state("p")
    assert s.already_running is False
    assert s.already_complete is True


def test_generation_state_neither_when_no_tasks(
    fake_sb: _FakeSupabase,
) -> None:
    """Stage advanced but no tasks → not running, not complete."""
    fake_sb.events = [
        _event(
            "p",
            id="e0",
            kind="stage_advanced",
            stage="generation",
            created_at="2025-01-01T00:00:00Z",
        ),
    ]
    s = pr.generation_state("p")
    assert s.already_running is False
    assert s.already_complete is False


# ---------------------------------------------------------------------------
# fetch_pipeline / picks_from_pipeline
# ---------------------------------------------------------------------------


def test_fetch_pipeline_returns_row_when_present(fake_sb: _FakeSupabase) -> None:
    fake_sb.pipeline_row = {"id": "p-1", "status": "ideation"}
    row = pr.fetch_pipeline("p-1")
    assert row == {"id": "p-1", "status": "ideation"}


def test_fetch_pipeline_returns_none_when_missing(fake_sb: _FakeSupabase) -> None:
    fake_sb.pipeline_row = None
    assert pr.fetch_pipeline("p-missing") is None


def test_fetch_pipeline_returns_none_when_data_is_list(
    fake_sb: _FakeSupabase,
) -> None:
    """Defensive: maybe_single can occasionally return a list; the
    helper must coerce non-dicts to ``None``."""
    fake_sb.pipeline_row = ["unexpected"]  # type: ignore[assignment]
    assert pr.fetch_pipeline("p-1") is None


def test_fetch_pipeline_returns_none_when_execute_returns_none(
    fake_sb: _FakeSupabase,
) -> None:
    """Regression: supabase-py returns None (not a response) from
    ``maybe_single().execute()`` when no row matches; fetch_pipeline must
    return None, not raise AttributeError (was a 500 on the operator read)."""
    fake_sb.execute_returns_none = True
    assert pr.fetch_pipeline("p-missing") is None


def test_picks_from_pipeline_happy_path() -> None:
    pipeline: dict[str, Any] = {
        "picks": {"image": ["i1", "i2"], "video": ["v1"]}
    }
    img, vid = pr.picks_from_pipeline(pipeline)
    assert img == ["i1", "i2"]
    assert vid == ["v1"]


def test_picks_from_pipeline_empty_when_picks_not_dict() -> None:
    """Exercises the ``not isinstance(raw, dict)`` branch (line 319)."""
    # None case
    img, vid = pr.picks_from_pipeline({"picks": None})
    assert img == []
    assert vid == []
    # List case
    img, vid = pr.picks_from_pipeline({"picks": []})
    assert img == []
    assert vid == []
    # String case
    img, vid = pr.picks_from_pipeline({"picks": "invalid"})
    assert img == []
    assert vid == []
    # Missing key
    img, vid = pr.picks_from_pipeline({})
    assert img == []
    assert vid == []


def test_picks_from_pipeline_filters_non_string_entries() -> None:
    """Non-string and empty-string entries are dropped defensively."""
    pipeline: dict[str, Any] = {
        "picks": {
            "image": ["i1", None, 42, "", "i2"],
            "video": [None, "v1"],
        }
    }
    img, vid = pr.picks_from_pipeline(pipeline)
    assert img == ["i1", "i2"]
    assert vid == ["v1"]


def test_picks_from_pipeline_missing_track_keys() -> None:
    """Picks dict without ``image`` / ``video`` keys yields empty lists."""
    img, vid = pr.picks_from_pipeline({"picks": {"other": ["x"]}})
    assert img == []
    assert vid == []


# ---------------------------------------------------------------------------
# emit_cost
# ---------------------------------------------------------------------------


def test_emit_cost_writes_payload_with_task_event_id_and_extra(
    fake_sb: _FakeSupabase,
) -> None:
    pr.emit_cost(
        pipeline_id="p",
        api="kie.ai",
        units=2,
        subtotal=0.10,
        task_event_id="ev-running",
        stage="generation",
        extra={"ratio": "1x1"},
    )
    name, row = fake_sb.inserts[-1]
    assert name == "pipeline_events"
    assert row["kind"] == pr.EVENT_COST_RECORDED
    assert row["stage"] == "generation"
    payload = row["payload"]
    assert payload["api"] == "kie.ai"
    assert payload["units"] == 2
    assert payload["subtotal"] == 0.10
    assert payload["task_event_id"] == "ev-running"
    assert payload["extra"] == {"ratio": "1x1"}


def test_emit_cost_omits_optional_fields_when_not_supplied(
    fake_sb: _FakeSupabase,
) -> None:
    pr.emit_cost(
        pipeline_id="p",
        api="elevenlabs",
        units=1,
        subtotal=0.05,
    )
    _, row = fake_sb.inserts[-1]
    payload = row["payload"]
    assert "task_event_id" not in payload
    assert "extra" not in payload
    # Default stage is generation.
    assert row["stage"] == "generation"


# ---------------------------------------------------------------------------
# pipeline_is_cancelled — worker-side abort poll for the cancel flow
# ---------------------------------------------------------------------------
#
# The dashboard's POST /api/pipelines/[id]/cancel route flips
# ``pipelines.status`` to ``'cancelled'``. The worker polls this helper
# between substages so a mid-flight Generation pipeline stops emitting
# events / burning Kie credits when the operator has cancelled it.


def test_pipeline_is_cancelled_true_when_status_cancelled(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.pipeline_row = {"status": "cancelled"}
    assert pr.pipeline_is_cancelled("p-1") is True


def test_pipeline_is_cancelled_false_when_status_active(
    fake_sb: _FakeSupabase,
) -> None:
    """Every non-cancelled status (ideation, review, generation, done) must
    return False so the worker continues normally."""
    for status in ("configuration", "ideation", "review", "generation", "done"):
        fake_sb.pipeline_row = {"status": status}
        assert pr.pipeline_is_cancelled("p-1") is False, status


def test_pipeline_is_cancelled_false_when_row_missing(
    fake_sb: _FakeSupabase,
) -> None:
    """A missing pipeline row must NOT trigger abort — that would short-
    circuit any pipeline whose row was momentarily unreadable."""
    fake_sb.pipeline_row = None
    assert pr.pipeline_is_cancelled("p-missing") is False


def test_pipeline_is_cancelled_false_when_row_not_dict(
    fake_sb: _FakeSupabase,
) -> None:
    """Defensive: maybe_single may occasionally return a non-dict.
    Treat as 'not cancelled' rather than crashing the substage loop."""
    fake_sb.pipeline_row = ["unexpected"]  # type: ignore[assignment]
    assert pr.pipeline_is_cancelled("p-1") is False


def test_pipeline_is_cancelled_false_on_supabase_error(
    fake_sb: _FakeSupabase,
) -> None:
    """A read failure must NOT abort the pipeline — transient Supabase
    flakes shouldn't cancel a running job. The worker carries on; the
    next emit_pipeline_event call would surface a real outage."""
    fake_sb.raise_on_execute = True
    assert pr.pipeline_is_cancelled("p-err") is False


# ===========================================================================
# Durable work-unit ledger: closure authoritative on pipeline_work_units (0019)
# ===========================================================================
#
# These exercise the replacement for the event-COUNT closure heuristic. The
# ledger is exact and key-addressable: closure = no open unit AND >= 1 exists;
# success = closed AND >= 1 done. The all-failed batch -- which the count
# heuristic mis-closed once -- must read as closed-but-NOT-success.


def _unit(pipeline_id: str, stage: str, status: str) -> dict:
    return {"pipeline_id": pipeline_id, "stage": stage, "status": status}


def test_fetch_work_unit_state_empty_when_no_ledger(
    fake_sb: _FakeSupabase,
) -> None:
    """No ledger rows -> all-zero state, has_units False (callers fall back)."""
    fake_sb.work_units = []
    st = pr.fetch_work_unit_state(pipeline_id="p", stage="generation")
    assert st.total == 0
    assert st.has_units is False
    assert st.closed is False
    assert st.succeeded is False


def test_fetch_work_unit_state_open_when_unit_running(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.work_units = [
        _unit("p", "generation", "done"),
        _unit("p", "generation", "running"),
    ]
    st = pr.fetch_work_unit_state(pipeline_id="p", stage="generation")
    assert st.total == 2
    assert st.open == 1
    assert st.done == 1
    assert st.closed is False  # a running unit keeps the stage open
    assert st.succeeded is False


def test_fetch_work_unit_state_queued_counts_as_open(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.work_units = [_unit("p", "generation", "queued")]
    st = pr.fetch_work_unit_state(pipeline_id="p", stage="generation")
    assert st.open == 1
    assert st.closed is False


def test_work_stage_succeeded_when_closed_with_a_done(
    fake_sb: _FakeSupabase,
) -> None:
    """Closed AND >= 1 done -> success."""
    fake_sb.work_units = [
        _unit("p", "generation", "done"),
        _unit("p", "generation", "error"),
    ]
    st = pr.fetch_work_unit_state(pipeline_id="p", stage="generation")
    assert st.closed is True
    assert st.succeeded is True
    assert pr.work_stage_closed(pipeline_id="p", stage="generation") is True
    assert pr.work_stage_succeeded(pipeline_id="p", stage="generation") is True


def test_work_stage_all_failed_is_closed_but_not_success(
    fake_sb: _FakeSupabase,
) -> None:
    """The documented bug guard: an ALL-ERROR batch is closed but NOT a
    success, so the stage must never advance on failure."""
    fake_sb.work_units = [
        _unit("p", "generation", "error"),
        _unit("p", "generation", "error"),
    ]
    st = pr.fetch_work_unit_state(pipeline_id="p", stage="generation")
    assert st.closed is True  # all terminal
    assert st.succeeded is False  # but zero done
    assert pr.work_stage_succeeded(pipeline_id="p", stage="generation") is False


def test_fetch_work_unit_state_scopes_by_pipeline_and_stage(
    fake_sb: _FakeSupabase,
) -> None:
    """Units for a different pipeline / stage are not counted."""
    fake_sb.work_units = [
        _unit("p", "generation", "done"),
        _unit("p", "finalize_assets", "running"),  # different stage
        _unit("other", "generation", "running"),  # different pipeline
    ]
    st = pr.fetch_work_unit_state(pipeline_id="p", stage="generation")
    assert st.total == 1
    assert st.done == 1
    assert st.open == 0
    assert st.succeeded is True


def test_fetch_work_unit_state_ignores_non_dict_rows(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.work_units = [
        _unit("p", "generation", "done"),
        "garbage",  # type: ignore[list-item]
    ]
    st = pr.fetch_work_unit_state(pipeline_id="p", stage="generation")
    assert st.total == 1
    assert st.done == 1


def test_fetch_work_unit_state_read_error_is_no_ledger(
    fake_sb: _FakeSupabase,
) -> None:
    """A read error degrades to the all-zero state so the caller falls back
    to the event heuristic rather than wrongly closing the stage."""
    fake_sb.raise_on_execute = True
    st = pr.fetch_work_unit_state(pipeline_id="p", stage="generation")
    assert st.has_units is False
    assert st.closed is False


# ---------------------------------------------------------------------------
# generation_state now reads the ledger first, event heuristic as fallback
# ---------------------------------------------------------------------------


def _gen_advance(pipeline_id: str = "p") -> dict:
    return _event(
        pipeline_id,
        id="e0",
        kind="stage_advanced",
        stage="generation",
        created_at="2025-01-01T00:00:00Z",
    )


def test_generation_state_ledger_running_when_unit_open(
    fake_sb: _FakeSupabase,
) -> None:
    """An open ledger unit => already_running, regardless of events."""
    fake_sb.events = [_gen_advance()]
    fake_sb.work_units = [_unit("p", "generation", "running")]
    s = pr.generation_state("p")
    assert s.already_running is True
    assert s.already_complete is False
    assert s.started_at == "2025-01-01T00:00:00Z"


def test_generation_state_ledger_complete_when_succeeded(
    fake_sb: _FakeSupabase,
) -> None:
    """Ledger closed with a done => already_complete."""
    fake_sb.events = [_gen_advance()]
    fake_sb.work_units = [
        _unit("p", "generation", "done"),
        _unit("p", "generation", "error"),
    ]
    s = pr.generation_state("p")
    assert s.already_running is False
    assert s.already_complete is True


def test_generation_state_ledger_all_failed_neither_running_nor_complete(
    fake_sb: _FakeSupabase,
) -> None:
    """The key regression: an ALL-FAILED ledger batch is neither running nor
    complete, so the route is free to re-dispatch instead of advancing."""
    fake_sb.events = [_gen_advance()]
    fake_sb.work_units = [
        _unit("p", "generation", "error"),
        _unit("p", "generation", "error"),
    ]
    s = pr.generation_state("p")
    assert s.already_running is False
    assert s.already_complete is False


def test_generation_state_falls_back_to_events_without_ledger(
    fake_sb: _FakeSupabase,
) -> None:
    """No ledger rows => the legacy event-count heuristic still drives state."""
    fake_sb.work_units = []
    fake_sb.events = [
        _gen_advance(),
        _event(
            "p",
            id="e1",
            kind="task_done",
            stage="generation",
            created_at="2025-01-01T00:00:01Z",
        ),
    ]
    s = pr.generation_state("p")
    # Event heuristic: a terminal-only timeline reads as complete.
    assert s.already_running is False
    assert s.already_complete is True
