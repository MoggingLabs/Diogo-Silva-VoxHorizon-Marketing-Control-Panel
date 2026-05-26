"""DB-backed tests for the scheduler-side work_item watchdog wrapper.

These exercise ``services.scheduler.run_work_item_watchdog_once`` end-to-
end: the held rows + consumer rows are written via psycopg, the wrapper
reads them through a real Supabase admin client *substitute*, and the
state transitions land in the schema (including the parent-chained
requeue with exponential backoff and the consumer status flips).

Uses a thin psycopg-backed double of the supabase-py surface the
wrapper relies on so the schema-level UPDATE / SELECT semantics fire on
the live constraints (the in-memory FakeSupabase from
``tests/conftest.py`` is FK/CHECK blind).
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import psycopg
import pytest


pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Thin psycopg-backed supabase-py double (constraint-firing).
# ---------------------------------------------------------------------------
#
# Implements only the surface the scheduler's work_item watchdog wrapper +
# work_queue facade actually call: select/in_/eq/order/limit/maybe_single,
# update().eq().eq(), insert(), rpc(). One connection per call; the test
# manages tx itself so the assertions read the committed state.


class _PgQuery:
    def __init__(self, conn, table: str) -> None:
        self._conn = conn
        self._table = table
        self._select_cols = "*"
        self._filters_eq: list[tuple[str, Any]] = []
        self._filters_in: list[tuple[str, list[Any]]] = []
        self._update_data: dict[str, Any] | None = None
        self._insert_data: dict[str, Any] | None = None
        self._maybe_single = False
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None

    def select(self, columns: str = "*", **_kw: Any) -> "_PgQuery":
        self._select_cols = columns
        return self

    def eq(self, col: str, val: Any) -> "_PgQuery":
        self._filters_eq.append((col, val))
        return self

    def in_(self, col: str, vals: list[Any]) -> "_PgQuery":
        self._filters_in.append((col, list(vals)))
        return self

    def order(self, col: str, *, desc: bool = False) -> "_PgQuery":
        self._order = (col, desc)
        return self

    def limit(self, n: int) -> "_PgQuery":
        self._limit = n
        return self

    def maybe_single(self) -> "_PgQuery":
        self._maybe_single = True
        return self

    def update(self, data: dict[str, Any]) -> "_PgQuery":
        self._update_data = dict(data)
        return self

    def insert(self, data: dict[str, Any]) -> "_PgQuery":
        self._insert_data = dict(data)
        return self

    def _where(self) -> tuple[str, list[Any]]:
        clauses = []
        params: list[Any] = []
        for col, val in self._filters_eq:
            clauses.append(f"{col} = %s")
            params.append(val)
        for col, vals in self._filters_in:
            placeholders = ", ".join(["%s"] * len(vals))
            clauses.append(f"{col} in ({placeholders})")
            params.extend(vals)
        return (" where " + " and ".join(clauses) if clauses else ""), params

    def execute(self) -> SimpleNamespace:
        if self._update_data is not None:
            cols = list(self._update_data.keys())
            assigns = ", ".join(f"{c}=%s" for c in cols)
            params = [
                json.dumps(v) if isinstance(v, dict) else v
                for v in self._update_data.values()
            ]
            where, where_params = self._where()
            sql = f"update {self._table} set {assigns}{where} returning *"
            with self._conn.cursor() as cur:
                cur.execute(sql, params + where_params)
                rows = cur.fetchall()
                colnames = [d.name for d in cur.description] if cur.description else []
            return SimpleNamespace(
                data=[dict(zip(colnames, r)) for r in rows]
            )
        if self._insert_data is not None:
            cols = list(self._insert_data.keys())
            placeholders = ", ".join(["%s"] * len(cols))
            params = [
                json.dumps(v) if isinstance(v, dict) else v
                for v in self._insert_data.values()
            ]
            sql = (
                f"insert into {self._table} ({', '.join(cols)}) "
                f"values ({placeholders}) returning *"
            )
            with self._conn.cursor() as cur:
                cur.execute(sql, params)
                row = cur.fetchone()
                colnames = [d.name for d in cur.description]
            return SimpleNamespace(
                data=[dict(zip(colnames, row))]
            )
        # Select.
        where, params = self._where()
        order = ""
        if self._order:
            col, desc = self._order
            order = f" order by {col} {'desc' if desc else 'asc'}"
        lim = f" limit {self._limit}" if self._limit is not None else ""
        sql = f"select {self._select_cols} from {self._table}{where}{order}{lim}"
        with self._conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
            colnames = [d.name for d in cur.description] if cur.description else []
        data = [dict(zip(colnames, r)) for r in rows]
        if self._maybe_single:
            return SimpleNamespace(data=(data[0] if data else None))
        return SimpleNamespace(data=data)


class _PgRpc:
    def __init__(self, conn, fn: str, params: dict[str, Any]) -> None:
        self._conn = conn
        self._fn = fn
        self._params = params

    def execute(self) -> SimpleNamespace:
        # Only the work_queue facade's claim_work_item RPC is needed here.
        if self._fn == "claim_work_item":
            with self._conn.cursor() as cur:
                cur.execute(
                    "select claim_work_item(%s::work_item_kind, %s)",
                    (self._params["p_kind"], self._params["p_consumer"]),
                )
                cur.execute(
                    "select * from work_item "
                    "where status='claimed' and claimed_by=%s "
                    "order by claimed_at desc limit 1",
                    (self._params["p_consumer"],),
                )
                row = cur.fetchone()
                if row is None:
                    return SimpleNamespace(data=None)
                colnames = [d.name for d in cur.description]
                return SimpleNamespace(data=dict(zip(colnames, row)))
        raise NotImplementedError(f"unsupported rpc: {self._fn}")


class PgFakeSupabase:
    """psycopg-backed supabase-py double for the scheduler wrapper tests."""

    def __init__(self, conn) -> None:
        self._conn = conn

    def table(self, name: str) -> _PgQuery:
        return _PgQuery(self._conn, name)

    def rpc(self, fn: str, params: dict[str, Any]) -> _PgRpc:
        return _PgRpc(self._conn, fn, params)


# ---------------------------------------------------------------------------
# Test fixtures: a committed pipeline + consumer + held row.
# ---------------------------------------------------------------------------


def _seed_pipeline_committed(pg_dsn: str) -> str:
    """Insert a pipeline + client outside any test transaction.

    The scheduler wrapper opens its own implicit transactions through the
    double; the test must commit the seed so the wrapper sees it.
    """
    conn = psycopg.connect(pg_dsn, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into clients (slug, name, service_type)
                values ('ow-' || substr(md5(random()::text), 1, 8),
                        'OW Test Client', 'roofing')
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
            pipeline_id = str(cur.fetchone()[0])
        return pipeline_id
    finally:
        conn.close()


def _cleanup(pg_dsn: str, pipeline_id: str) -> None:
    conn = psycopg.connect(pg_dsn, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "delete from work_item where pipeline_id=%s", (pipeline_id,)
            )
            cur.execute(
                "delete from pipelines where id=%s", (pipeline_id,)
            )
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_run_work_item_watchdog_requeues_with_parent_chain(pg_dsn: str) -> None:
    """A stuck row is timed_out + a fresh row is enqueued chained to it."""
    pipeline_id = _seed_pipeline_committed(pg_dsn)
    conn = psycopg.connect(pg_dsn, autocommit=True)
    try:
        # Seed one CLAIMED row with a stale heartbeat (5 minutes ago, well over
        # the 120-second default threshold).
        stale = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into work_item
                  (kind, pipeline_id, status, payload, idempotency_key, created_by,
                   claim_token, claimed_by, claimed_at, heartbeat_at, attempt)
                values ('operator_dispatch', %s, 'running', '{}'::jsonb,
                        'ow-stuck-1', 'test',
                        gen_random_uuid(), 'consumer-A', %s, %s, 1)
                returning id
                """,
                (pipeline_id, stale, stale),
            )
            stuck_id = str(cur.fetchone()[0])

        from src.config import Settings
        from src.services.scheduler import run_work_item_watchdog_once

        sb = PgFakeSupabase(conn)
        settings = Settings(
            worker_shared_secret="test",
            work_item_max_attempts=3,
            work_item_heartbeat_threshold_s=60,
            work_item_consumer_heartbeat_s=30,
            work_item_watchdog_max_per_pass=10,
            work_item_backoff_base_s=10,
            work_item_backoff_cap_s=600,
        )
        counts = asyncio.run(
            run_work_item_watchdog_once(sb, settings=settings)
        )
        assert counts["rotated"] == 1
        assert counts["requeued"] == 1
        assert counts["dead_lettered"] == 0

        # The original row is now timed_out, claim cleared.
        with conn.cursor() as cur:
            cur.execute(
                "select status, error_kind, claim_token from work_item where id=%s",
                (stuck_id,),
            )
            row = cur.fetchone()
            assert row[0] == "timed_out"
            assert row[1] == "heartbeat_stale"
            assert row[2] is None

        # A new row exists with parent_work_item_id = stuck_id.
        with conn.cursor() as cur:
            cur.execute(
                "select id, status, parent_work_item_id from work_item "
                "where parent_work_item_id=%s",
                (stuck_id,),
            )
            child = cur.fetchone()
            assert child is not None
            assert child[1] == "queued"
            assert str(child[2]) == stuck_id
    finally:
        conn.close()
        _cleanup(pg_dsn, pipeline_id)


def test_run_work_item_watchdog_dead_letters_at_max_attempts(pg_dsn: str) -> None:
    """A row whose attempt >= max_attempts is marked failed (not requeued)."""
    pipeline_id = _seed_pipeline_committed(pg_dsn)
    conn = psycopg.connect(pg_dsn, autocommit=True)
    try:
        stale = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into work_item
                  (kind, pipeline_id, status, payload, idempotency_key, created_by,
                   claim_token, claimed_by, claimed_at, heartbeat_at, attempt)
                values ('operator_dispatch', %s, 'running', '{}'::jsonb,
                        'ow-deadletter-1', 'test',
                        gen_random_uuid(), 'consumer-A', %s, %s, 3)
                returning id
                """,
                (pipeline_id, stale, stale),
            )
            deadletter_id = str(cur.fetchone()[0])

        from src.config import Settings
        from src.services.scheduler import run_work_item_watchdog_once

        sb = PgFakeSupabase(conn)
        settings = Settings(
            worker_shared_secret="test",
            work_item_max_attempts=3,
            work_item_heartbeat_threshold_s=60,
            work_item_watchdog_max_per_pass=10,
        )
        counts = asyncio.run(
            run_work_item_watchdog_once(sb, settings=settings)
        )
        assert counts["rotated"] == 1
        assert counts["requeued"] == 0
        assert counts["dead_lettered"] == 1

        with conn.cursor() as cur:
            cur.execute(
                "select status, error_kind from work_item where id=%s",
                (deadletter_id,),
            )
            row = cur.fetchone()
            assert row[0] == "failed"
            assert row[1] == "max_attempts_exceeded"
            # No child row was enqueued for the dead-lettered work.
            cur.execute(
                "select count(*) from work_item where parent_work_item_id=%s",
                (deadletter_id,),
            )
            assert cur.fetchone()[0] == 0
    finally:
        conn.close()
        _cleanup(pg_dsn, pipeline_id)


def test_run_work_item_watchdog_flips_stale_consumer(pg_dsn: str) -> None:
    """A consumer whose last_seen_at is >= 4x heartbeat interval flips to down."""
    pipeline_id = _seed_pipeline_committed(pg_dsn)
    conn = psycopg.connect(pg_dsn, autocommit=True)
    try:
        # 5 minutes idle is well past the 4x = 120-second 'down' threshold.
        idle = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        consumer_id = f"daemon-test-{datetime.now().timestamp()}"
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into work_item_consumers
                  (id, kind, status, last_seen_at)
                values (%s, 'operator_dispatch', 'live', %s)
                """,
                (consumer_id, idle),
            )

        from src.config import Settings
        from src.services.scheduler import run_work_item_watchdog_once

        sb = PgFakeSupabase(conn)
        settings = Settings(
            worker_shared_secret="test",
            work_item_consumer_heartbeat_s=30,
            work_item_heartbeat_threshold_s=60,
            work_item_watchdog_max_per_pass=10,
        )
        counts = asyncio.run(
            run_work_item_watchdog_once(sb, settings=settings)
        )
        assert counts["consumers_flipped"] >= 1

        with conn.cursor() as cur:
            cur.execute(
                "select status from work_item_consumers where id=%s",
                (consumer_id,),
            )
            assert cur.fetchone()[0] == "down"
            cur.execute(
                "delete from work_item_consumers where id=%s", (consumer_id,)
            )
    finally:
        conn.close()
        _cleanup(pg_dsn, pipeline_id)
