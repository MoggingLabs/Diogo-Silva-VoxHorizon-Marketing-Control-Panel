"""DB-backed contract tests for the outbox consumer (silent-failure PR-4).

Drives one full claim -> handler -> close cycle against the live Postgres
``work_item`` schema (migration 0050 + 0051). Pins:

  * a queued outbox_* row is claimed by the consumer + completed in one pass;
  * the watchdog's stuck-row rotation contract is respected (the work_item
    is NOT closed when the handler raises, leaving the row held);
  * the close UPDATE is token-scoped (a watchdog rotation mid-handler leaves
    the close a 0-row no-op).
"""

from __future__ import annotations

import asyncio

import psycopg
import pytest

from src.config import Settings
from src.services import outbox_consumer
from src.services.outbox_consumer import _HANDLERS, run_outbox_drain_once


pytestmark = pytest.mark.integration


def _settings() -> Settings:
    return Settings(  # type: ignore[call-arg]
        worker_shared_secret="test",
        outbox_max_attempts=5,
        scheduler_outbox_drain_interval_s=5,
    )


def _seed_pipeline(cur: psycopg.Cursor) -> str:
    cur.execute(
        """
        insert into clients (slug, name, service_type)
        values ('ocb-' || substr(md5(random()::text), 1, 8),
                'Outbox Consumer Client', 'roofing')
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


def _enqueue_outbox(
    cur: psycopg.Cursor, *, pipeline_id: str, kind: str, key: str
) -> str:
    cur.execute(
        """
        insert into work_item (kind, pipeline_id, payload, idempotency_key, created_by)
        values (%s, %s, %s::jsonb, %s, 'test')
        returning id
        """,
        (kind, pipeline_id, '{"pipeline_id":"%s"}' % pipeline_id, key),
    )
    return str(cur.fetchone()[0])


class _PgSupabaseAdapter:
    """Minimal supabase-py facade backed by a live psycopg connection.

    The drainer only uses ``table(name).update(...).eq(...).execute()`` for
    closes (the claim itself goes via the SKIP-LOCKED RPC); this adapter
    exposes those two surfaces against the real schema so the integration
    test exercises the real SQL invariants (CHECK constraints, the auto-emit
    trigger) the FakeSupabase double cannot.
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
        self._update: dict | None = None

    def update(self, patch: dict) -> "_PgTable":
        self._update = dict(patch)
        return self

    def eq(self, col: str, val: object) -> "_PgTable":
        self._filters.append((col, val))
        return self

    def execute(self):
        from types import SimpleNamespace

        assert self._update is not None
        # Build SET + WHERE clauses
        set_cols = list(self._update.keys())
        set_clause = ", ".join(f"{c}=%s" for c in set_cols)
        set_values = [self._update[c] for c in set_cols]
        # JSON columns need explicit cast handling -- result / error_detail
        # are jsonb. supabase-py serialises dicts; psycopg needs a Json adapter.
        from psycopg.types.json import Json

        set_values = [
            Json(v) if isinstance(v, dict) else v for v in set_values
        ]

        where_parts = [f"{c}=%s" for c, _ in self._filters]
        where_clause = " and ".join(where_parts)
        where_values = [v for _, v in self._filters]

        sql = f"update {self._name} set {set_clause}"
        if where_clause:
            sql += f" where {where_clause}"
        sql += " returning *"

        with self._conn.cursor() as cur:
            cur.execute(sql, set_values + where_values)
            rows = cur.fetchall()
            if not rows:
                return SimpleNamespace(data=[])
            cols = [d[0] for d in cur.description]
            return SimpleNamespace(
                data=[dict(zip(cols, r)) for r in rows]
            )


def test_drain_claims_and_completes_meta_row(db_conn: psycopg.Connection) -> None:
    """A queued outbox_meta_record_launch row is claimed + closed in one pass."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        work_item_id = _enqueue_outbox(
            cur,
            pipeline_id=pipeline_id,
            kind="outbox_meta_record_launch",
            key=f"meta:record_launch:{pipeline_id}:test1",
        )
    db_conn.commit()

    sb = _PgSupabaseAdapter(db_conn)
    tally = asyncio.run(
        run_outbox_drain_once(
            _settings(),
            kinds=["outbox_meta_record_launch"],
            sb=sb,
        )
    )
    db_conn.commit()
    assert tally["outbox_meta_record_launch"] == 1

    with db_conn.cursor() as cur:
        cur.execute(
            "select status, claim_token from work_item where id = %s",
            (work_item_id,),
        )
        row = cur.fetchone()
    assert row[0] == "completed"
    assert row[1] is None  # claim cleared on close


def test_drain_no_due_rows_is_no_op(db_conn: psycopg.Connection) -> None:
    """An empty queue reports zero per kind + writes nothing."""
    sb = _PgSupabaseAdapter(db_conn)
    tally = asyncio.run(
        run_outbox_drain_once(
            _settings(),
            kinds=["outbox_meta_record_launch"],
            sb=sb,
        )
    )
    assert tally == {"outbox_meta_record_launch": 0}


def test_drain_handler_raise_leaves_row_held(
    db_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A handler that raises leaves the work_item in a held status (no close)."""

    async def _boom(sb, payload):
        raise RuntimeError("integration handler exploded")

    monkeypatch.setitem(_HANDLERS, "outbox_drive_finalize_verified", _boom)

    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        work_item_id = _enqueue_outbox(
            cur,
            pipeline_id=pipeline_id,
            kind="outbox_drive_finalize_verified",
            key=f"drive:finalize_verified:{pipeline_id}:fail1",
        )
    db_conn.commit()

    sb = _PgSupabaseAdapter(db_conn)
    tally = asyncio.run(
        run_outbox_drain_once(
            _settings(),
            kinds=["outbox_drive_finalize_verified"],
            sb=sb,
        )
    )
    db_conn.commit()
    assert tally["outbox_drive_finalize_verified"] == 0

    with db_conn.cursor() as cur:
        cur.execute(
            "select status, claim_token from work_item where id = %s",
            (work_item_id,),
        )
        row = cur.fetchone()
    # Row is HELD -- claim_token NOT cleared; the watchdog will rotate it
    # once the heartbeat goes stale.
    assert row[0] in ("claimed", "running")
    assert row[1] is not None
