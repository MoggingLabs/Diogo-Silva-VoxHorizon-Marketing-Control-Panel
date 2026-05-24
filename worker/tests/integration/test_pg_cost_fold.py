"""Integration: cost_actual fold is incremental, not an O(n^2) re-sum (E7.3 / #537 / 0043).

Proves migration ``0043_cost_fold_incremental.sql`` against a REAL Postgres with
the actual ``db/migrations/*.sql`` applied:

  1. EQUIVALENCE -- inserting several ``cost_recorded`` events still produces the
     same ``pipelines.cost_actual`` the 0007 fold did: ``items[]`` carries one
     row per event (api / units / subtotal / actual_cost, plus task_event_id /
     extra when present) and ``total`` equals the running sum of every event's
     subtotal. This is what the web readers consume (StageGeneration's
     ``.total``; StageDone's ``.items[]`` + ``.total``), so the column contract
     is unchanged and no reader is repointed.

  2. NO O(n^2) REWRITE -- the fold function no longer re-aggregates the whole
     ``items[]`` array on each insert. We inspect ``pg_get_functiondef`` and
     assert it does the cheap incremental add (``+ v_subtotal`` onto the prior
     ``->>'total'``) and does NOT call ``jsonb_array_elements`` to re-sum the
     array (the 0007 hot-path scan that scaled O(events) per insert).

These run only when a Postgres is reachable (DATABASE_URL or testcontainers +
Docker); otherwise the whole tier skips cleanly (see integration/conftest.py).
"""

from __future__ import annotations

import json

import pytest


pytestmark = pytest.mark.integration


def _insert_cost_event(
    cur,
    pipeline_id: str,
    *,
    api: str,
    units: float,
    subtotal: float,
    task_event_id: str | None = None,
    extra: dict | None = None,
) -> None:
    """Insert one cost_recorded pipeline_events row (fires the 0043 fold)."""
    payload: dict = {"api": api, "units": units, "subtotal": subtotal}
    if task_event_id is not None:
        payload["task_event_id"] = task_event_id
    if extra is not None:
        payload["extra"] = extra
    cur.execute(
        """
        insert into pipeline_events (pipeline_id, kind, stage, payload)
        values (%s, 'cost_recorded', 'generation', %s::jsonb)
        """,
        (pipeline_id, json.dumps(payload)),
    )


def _read_cost_actual(cur, pipeline_id: str) -> dict:
    """Return the pipelines.cost_actual jsonb for a pipeline (as a dict)."""
    cur.execute("select cost_actual from pipelines where id = %s", (pipeline_id,))
    row = cur.fetchone()
    assert row is not None, "pipeline row missing"
    value = row[0]
    # psycopg returns jsonb as a parsed object already; tolerate a str just in case.
    return json.loads(value) if isinstance(value, str) else value


# ===========================================================================
# 1. Equivalence: the incremental fold yields the same column the 0007 fold did.
# ===========================================================================


def test_cost_actual_total_matches_sum_over_several_events(db_conn, image_creative) -> None:
    """Several cost_recorded events fold into total == sum, one item each."""
    pid = image_creative["pipeline_id"]
    subtotals = [0.05, 0.05, 1.20, 0.44, 0.00, 0.07]
    with db_conn.cursor() as cur:
        for i, sub in enumerate(subtotals):
            _insert_cost_event(
                cur,
                pid,
                api="kie.ai",
                units=1,
                subtotal=sub,
                task_event_id=f"task-{i}",
            )

        cost_actual = _read_cost_actual(cur, pid)

    items = cost_actual["items"]
    assert len(items) == len(subtotals), "one item per cost_recorded event"
    # total is the running sum of every event's subtotal (== the 0007 result).
    assert cost_actual["total"] == pytest.approx(sum(subtotals))
    # Each item preserves the 0007 shape the StageDone breakdown table reads.
    for item, sub in zip(items, subtotals):
        assert item["api"] == "kie.ai"
        assert float(item["subtotal"]) == pytest.approx(sub)
        assert float(item["actual_cost"]) == pytest.approx(sub)


def test_cost_actual_seeds_from_null_on_first_event(db_conn, image_creative) -> None:
    """A pipeline starting with NULL cost_actual seeds { items: [item], total }."""
    pid = image_creative["pipeline_id"]
    with db_conn.cursor() as cur:
        # Pristine pipeline: cost_actual is NULL until the first cost event.
        cur.execute("select cost_actual from pipelines where id = %s", (pid,))
        assert cur.fetchone()[0] is None

        _insert_cost_event(cur, pid, api="openai-codex", units=2, subtotal=0.30)
        cost_actual = _read_cost_actual(cur, pid)

    assert len(cost_actual["items"]) == 1
    assert cost_actual["total"] == pytest.approx(0.30)
    assert cost_actual["items"][0]["api"] == "openai-codex"


def test_cost_actual_preserves_task_event_id_and_extra(db_conn, image_creative) -> None:
    """Optional task_event_id / extra carry through into the folded item."""
    pid = image_creative["pipeline_id"]
    with db_conn.cursor() as cur:
        _insert_cost_event(
            cur,
            pid,
            api="kie-video",
            units=1,
            subtotal=0.40,
            task_event_id="evt-9",
            extra={"creative_id": "c-1", "clip": 3},
        )
        cost_actual = _read_cost_actual(cur, pid)

    item = cost_actual["items"][0]
    assert item["task_event_id"] == "evt-9"
    assert item["extra"] == {"creative_id": "c-1", "clip": 3}
    assert cost_actual["total"] == pytest.approx(0.40)


def test_malformed_cost_event_does_not_fold_or_abort(db_conn, image_creative) -> None:
    """A cost_recorded with no api is a defensive no-op (insert still lands)."""
    pid = image_creative["pipeline_id"]
    with db_conn.cursor() as cur:
        # No 'api' key -> the fold returns early; the event row still inserts.
        cur.execute(
            """
            insert into pipeline_events (pipeline_id, kind, stage, payload)
            values (%s, 'cost_recorded', 'generation', '{"units": 1}'::jsonb)
            """,
            (pid,),
        )
        cur.execute("select cost_actual from pipelines where id = %s", (pid,))
        assert cur.fetchone()[0] is None  # untouched

        # A well-formed event after it still folds correctly (total = 0.10).
        _insert_cost_event(cur, pid, api="kie.ai", units=1, subtotal=0.10)
        cost_actual = _read_cost_actual(cur, pid)

    assert len(cost_actual["items"]) == 1
    assert cost_actual["total"] == pytest.approx(0.10)


# ===========================================================================
# 2. The O(n^2) array re-sum is gone from the fold function.
# ===========================================================================


def _fold_function_def(cur) -> str:
    """Return the source of pipeline_events_apply_cost_actual()."""
    cur.execute(
        "select pg_get_functiondef('public.pipeline_events_apply_cost_actual()'::regprocedure)"
    )
    return cur.fetchone()[0]


def test_fold_function_is_incremental_not_array_resum(db_conn) -> None:
    """The fold adds the single subtotal; it no longer re-sums items[] per insert."""
    with db_conn.cursor() as cur:
        body = _fold_function_def(cur).lower()

    # The 0007 hot-path scan: re-summing the whole array with
    # jsonb_array_elements() on every insert. Must be gone.
    assert "jsonb_array_elements" not in body, (
        "fold still re-sums items[] per insert (the O(n^2) 0007 hazard)"
    )
    # The 0043 incremental add: prior total + the single new subtotal.
    assert "+ v_subtotal" in body, "fold should add the single new subtotal incrementally"
    assert "->>'total'" in body, "fold should read the prior total, not recompute it"


def test_fold_trigger_still_wired_for_cost_recorded(db_conn) -> None:
    """The trigger name + firing condition are unchanged (no downstream rewiring)."""
    with db_conn.cursor() as cur:
        cur.execute(
            """
            select tgname, pg_get_triggerdef(t.oid)
              from pg_trigger t
              join pg_class c on c.oid = t.tgrelid
             where c.relname = 'pipeline_events'
               and t.tgname = 'pipeline_events_cost_actual_trg'
            """
        )
        row = cur.fetchone()

    assert row is not None, "cost_actual fold trigger missing"
    triggerdef = row[1].lower()
    assert "after insert" in triggerdef
    assert "cost_recorded" in triggerdef
    assert "pipeline_events_apply_cost_actual" in triggerdef
