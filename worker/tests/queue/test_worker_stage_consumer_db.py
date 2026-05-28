"""DB-backed contract tests for the worker-stage consumer (silent-failure PR-8).

Drives one full claim -> running(heartbeat) -> complete cycle against the live
Postgres ``work_item`` schema (migration 0050 + 0051), proving the consumer's
lifecycle satisfies the real SQL invariants the in-memory FakeSupabase double
cannot (the ``work_item_claim_consistent`` / ``work_item_running_heartbeated`` /
``work_item_terminal_closed`` CHECK constraints + the auto-emit trigger). The
real ideation/generation orchestration is stubbed here (it needs Kie + a full
pipeline; that path is exercised end-to-end by the e2e suite) so this isolates
the queue lifecycle. Pins:

  * a queued ``worker_ideation`` row is claimed, transitioned ``running`` with a
    heartbeat, and completed in one pass (claim cleared);
  * an unexpected handler fault closes the row ``failed`` with a classified
    ``error_kind`` (the row leaves a terminal, explained status -- not held);
  * an empty queue is a no-op.
"""

from __future__ import annotations

import asyncio
from typing import Any

import psycopg
import pytest

from src.config import Settings
from src.services import worker_stage_consumer
from src.services.worker_stage_consumer import _HANDLERS, run_worker_stage_drain_once


pytestmark = pytest.mark.integration


def _settings() -> Settings:
    return Settings(  # type: ignore[call-arg]
        worker_shared_secret="test",
        work_item_consumer_heartbeat_s=1,
        scheduler_worker_stage_interval_s=5,
    )


def _seed_pipeline(cur: psycopg.Cursor) -> str:
    cur.execute(
        """
        insert into clients (slug, name, service_type)
        values ('wsc-' || substr(md5(random()::text), 1, 8),
                'Worker Stage Consumer Client', 'roofing')
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


def _enqueue_worker_stage(
    cur: psycopg.Cursor, *, pipeline_id: str, kind: str, key: str
) -> str:
    cur.execute(
        """
        insert into work_item (kind, pipeline_id, payload, idempotency_key, created_by)
        values (%s, %s, %s::jsonb, %s, 'test')
        returning id
        """,
        (kind, pipeline_id, '{"stage":"ideation"}', key),
    )
    return str(cur.fetchone()[0])


class _PgSupabaseAdapter:
    """Minimal supabase-py facade backed by a live psycopg connection.

    The consumer uses ``rpc('claim_work_item', ...)`` for the atomic claim and
    ``table('work_item').update(...).eq(...).in_(...).execute()`` for the
    heartbeat / complete / fail closes. This adapter exposes both against the
    real schema so the integration test exercises the real CHECK constraints +
    the auto-emit trigger. Mirrors the adapter in
    ``tests/queue/test_outbox_consumer_db.py`` with the ``in_`` filter the
    heartbeat's status guard needs.
    """

    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def table(self, name: str) -> "_PgTable":
        return _PgTable(self._conn, name)

    def rpc(self, fn: str, params: dict) -> "_PgRpc":
        return _PgRpc(self._conn, fn, params)


class _PgRpc:
    def __init__(self, conn: psycopg.Connection, fn: str, params: dict) -> None:
        self._conn = conn
        self._fn = fn
        self._params = params

    def execute(self):
        from types import SimpleNamespace

        with self._conn.cursor() as cur:
            cur.execute(
                f"select * from {self._fn}(%s, %s)",
                (self._params["p_kind"], self._params["p_consumer"]),
            )
            row = cur.fetchone()
            if not row:
                return SimpleNamespace(data=None)
            cols = [d[0] for d in cur.description]
            data = dict(zip(cols, row))
            if not data.get("id"):
                return SimpleNamespace(data=None)
            return SimpleNamespace(data=data)


class _PgTable:
    def __init__(self, conn: psycopg.Connection, name: str) -> None:
        self._conn = conn
        self._name = name
        self._filters: list[tuple[str, object]] = []
        self._in_filters: list[tuple[str, tuple]] = []
        self._update: dict | None = None

    def update(self, patch: dict) -> "_PgTable":
        self._update = dict(patch)
        return self

    def eq(self, col: str, val: object) -> "_PgTable":
        self._filters.append((col, val))
        return self

    def in_(self, col: str, vals: list) -> "_PgTable":
        self._in_filters.append((col, tuple(vals)))
        return self

    def execute(self):
        from types import SimpleNamespace

        assert self._update is not None
        from psycopg.types.json import Json

        set_cols = list(self._update.keys())
        set_clause = ", ".join(f"{c}=%s" for c in set_cols)
        set_values = [
            Json(v) if isinstance(v, dict) else v
            for v in (self._update[c] for c in set_cols)
        ]

        where_parts = [f"{c}=%s" for c, _ in self._filters]
        where_values = [v for _, v in self._filters]
        for col, vals in self._in_filters:
            placeholders = ", ".join(["%s"] * len(vals))
            where_parts.append(f"{col} in ({placeholders})")
            where_values.extend(vals)

        sql = f"update {self._name} set {set_clause}"
        if where_parts:
            sql += " where " + " and ".join(where_parts)
        sql += " returning *"

        with self._conn.cursor() as cur:
            cur.execute(sql, set_values + where_values)
            rows = cur.fetchall()
            if not rows:
                return SimpleNamespace(data=[])
            cols = [d[0] for d in cur.description]
            return SimpleNamespace(data=[dict(zip(cols, r)) for r in rows])


def test_drain_claims_runs_and_completes_ideation_row(
    db_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A queued worker_ideation row is claimed, run, + completed in one pass."""
    seen: list[str] = []

    async def _ok(pipeline_id: str) -> dict[str, Any]:
        seen.append(pipeline_id)
        return {"pipeline_id": pipeline_id, "already_run": False}

    monkeypatch.setitem(_HANDLERS, "worker_ideation", _ok)

    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        work_item_id = _enqueue_worker_stage(
            cur,
            pipeline_id=pipeline_id,
            kind="worker_ideation",
            key=f"wi:{pipeline_id}:ideation",
        )
    db_conn.commit()

    sb = _PgSupabaseAdapter(db_conn)
    tally = asyncio.run(
        run_worker_stage_drain_once(_settings(), kinds=["worker_ideation"], sb=sb)
    )
    db_conn.commit()
    assert tally["worker_ideation"] == 1
    assert seen == [pipeline_id]

    with db_conn.cursor() as cur:
        cur.execute(
            "select status, claim_token, heartbeat_at, completed_at, result "
            "from work_item where id = %s",
            (work_item_id,),
        )
        status, claim_token, heartbeat_at, completed_at, result = cur.fetchone()
    assert status == "completed"
    assert claim_token is None  # claim cleared on close
    assert heartbeat_at is not None  # the claimed->running beat minted it
    assert completed_at is not None
    assert result["pipeline_id"] == pipeline_id


def test_drain_unexpected_fault_fails_row(
    db_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unexpected handler fault closes the work_item failed + explained."""

    async def _boom(pipeline_id: str) -> dict[str, Any]:
        raise RuntimeError("integration stage exploded")

    monkeypatch.setitem(_HANDLERS, "worker_generation", _boom)

    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        work_item_id = _enqueue_worker_stage(
            cur,
            pipeline_id=pipeline_id,
            kind="worker_generation",
            key=f"wg:{pipeline_id}:generation",
        )
    db_conn.commit()

    sb = _PgSupabaseAdapter(db_conn)
    tally = asyncio.run(
        run_worker_stage_drain_once(
            _settings(), kinds=["worker_generation"], sb=sb
        )
    )
    db_conn.commit()
    assert tally["worker_generation"] == 0

    with db_conn.cursor() as cur:
        cur.execute(
            "select status, claim_token, error_kind from work_item where id = %s",
            (work_item_id,),
        )
        status, claim_token, error_kind = cur.fetchone()
    # A terminal, EXPLAINED failure (the work_item_failure_explained CHECK
    # requires error_kind) -- the row is not left silently held.
    assert status == "failed"
    assert claim_token is None
    assert error_kind == "stage_execution_error"


def test_drain_no_due_rows_is_no_op(db_conn: psycopg.Connection) -> None:
    """An empty queue reports zero per kind + writes nothing."""
    sb = _PgSupabaseAdapter(db_conn)
    tally = asyncio.run(
        run_worker_stage_drain_once(
            _settings(), kinds=["worker_ideation", "worker_generation"], sb=sb
        )
    )
    assert tally == {"worker_ideation": 0, "worker_generation": 0}


@pytest.mark.parametrize(
    "kind,stage",
    [
        ("worker_qa", "creative_qa"),
        ("worker_compliance", "compliance_review"),
        ("worker_spec", "spec_validation"),
    ],
)
def test_fix_a_kinds_drain_through_lifecycle(
    db_conn: psycopg.Connection,
    monkeypatch: pytest.MonkeyPatch,
    kind: str,
    stage: str,
) -> None:
    """FIX-A: each new deterministic gate kind claims->runs->completes on real PG.

    Validates the migration-0053a enum value + the 0053b auto-emit mapping at the
    DB level (the emit trigger must map the new kind to task_queued/done, not
    crash on an unknown kind). The handler is stubbed -- the in-process
    verdict-writer fan-out is covered by the unit tests + the e2e.
    """

    async def _ok(pipeline_id: str) -> dict[str, Any]:
        return {"pipeline_id": pipeline_id, "stage": stage}

    monkeypatch.setitem(_HANDLERS, kind, _ok)

    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        cur.execute(
            """
            insert into work_item (kind, pipeline_id, payload, idempotency_key, created_by)
            values (%s, %s, %s::jsonb, %s, 'test')
            returning id
            """,
            (kind, pipeline_id, f'{{"stage":"{stage}"}}', f"wi:{pipeline_id}:{stage}"),
        )
        work_item_id = str(cur.fetchone()[0])
    db_conn.commit()

    sb = _PgSupabaseAdapter(db_conn)
    tally = asyncio.run(run_worker_stage_drain_once(_settings(), kinds=[kind], sb=sb))
    db_conn.commit()
    assert tally[kind] == 1

    with db_conn.cursor() as cur:
        cur.execute(
            "select status, claim_token from work_item where id = %s", (work_item_id,)
        )
        status, claim_token = cur.fetchone()
        assert status == "completed"
        assert claim_token is None
        # The auto-emit trigger mapped the new kind to task_* events (NOT
        # stage_advanced), so the per-creative gate work never moves the macro
        # status -- assert the queued event is task_queued, not stage_advanced.
        cur.execute(
            "select kind from pipeline_events where pipeline_id = %s "
            "and payload->>'work_item_id' = %s order by seq",
            (pipeline_id, work_item_id),
        )
        emitted = [str(r[0]) for r in cur.fetchall()]
        assert "task_queued" in emitted
        assert "task_done" in emitted
        assert "stage_advanced" not in emitted
