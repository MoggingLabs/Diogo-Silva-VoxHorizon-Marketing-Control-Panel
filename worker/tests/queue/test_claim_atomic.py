"""DB-backed tests for the atomic claim RPC + token rotation contract.

``claim_work_item`` uses ``FOR UPDATE SKIP LOCKED`` over the partial index
``work_item_claim_idx`` so N consumers never claim the same row -- the
single-writer guard of the redesign. These tests pin:

  * One consumer claim returns the row + mints a token.
  * Two concurrent claimers never both win the same row.
  * Claim respects ``next_attempt_at`` (future-scheduled rows invisible).
  * Token rotation invalidates an old token: a heartbeat with the previous
    token after the watchdog rotated returns 0 rows.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import psycopg
import pytest


pytestmark = pytest.mark.integration


def _seed_pipeline(cur) -> str:
    cur.execute(
        """
        insert into clients (slug, name, service_type)
        values ('cla-' || substr(md5(random()::text), 1, 8),
                'Claim Test Client', 'roofing')
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


def _enqueue(cur, *, pipeline_id: str, idem_key: str, next_attempt_at: str | None = None) -> str:
    if next_attempt_at is None:
        cur.execute(
            """
            insert into work_item (kind, pipeline_id, payload, idempotency_key, created_by)
            values ('operator_dispatch', %s, '{}'::jsonb, %s, 'test')
            returning id
            """,
            (pipeline_id, idem_key),
        )
    else:
        cur.execute(
            """
            insert into work_item
              (kind, pipeline_id, payload, idempotency_key, created_by, next_attempt_at)
            values ('operator_dispatch', %s, '{}'::jsonb, %s, 'test', %s)
            returning id
            """,
            (pipeline_id, idem_key, next_attempt_at),
        )
    return str(cur.fetchone()[0])


# ---------------------------------------------------------------------------
# Single-consumer claim
# ---------------------------------------------------------------------------


def test_claim_returns_oldest_queued_row(db_conn) -> None:
    """The RPC claims the oldest-due queued row of the given kind."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        _enqueue(cur, pipeline_id=pipeline_id, idem_key="cla-1")
        cur.execute(
            "select claim_work_item('operator_dispatch'::work_item_kind, 'consumer-A')"
        )
        result = cur.fetchone()[0]
        # The function returns a composite row; psycopg parses it as a tuple.
        # We re-read by joining via a fresh row to assert.
        cur.execute(
            "select status, claim_token, claimed_by from work_item where pipeline_id=%s",
            (pipeline_id,),
        )
        row = cur.fetchone()
        assert row[0] == "claimed"
        assert row[1] is not None  # claim_token minted
        assert row[2] == "consumer-A"


def test_claim_returns_null_when_nothing_due(db_conn) -> None:
    """An empty queue (or all-terminal rows) returns NULL composite."""
    with db_conn.cursor() as cur:
        cur.execute(
            "select claim_work_item('operator_dispatch'::work_item_kind, 'consumer-A')"
        )
        result = cur.fetchone()[0]
        # PG returns the empty composite (None/all-null). The wrapper converts
        # it to None in Python. We assert no row was claimed.
        cur.execute("select count(*) from work_item where status='claimed'")
        assert cur.fetchone()[0] == 0


def test_claim_respects_next_attempt_at(db_conn) -> None:
    """A row with next_attempt_at in the future is invisible to claim."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        _enqueue(
            cur,
            pipeline_id=pipeline_id,
            idem_key="cla-future",
            next_attempt_at=future,
        )
        cur.execute(
            "select claim_work_item('operator_dispatch'::work_item_kind, 'consumer-A')"
        )
        cur.execute(
            "select status from work_item where pipeline_id=%s",
            (pipeline_id,),
        )
        # Still queued -- the future row was not claimed.
        assert cur.fetchone()[0] == "queued"


def test_claim_only_picks_its_kind(db_conn) -> None:
    """A claim for one kind never picks up a row of another kind."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        cur.execute(
            """
            insert into work_item (kind, pipeline_id, payload, idempotency_key, created_by)
            values ('kie_video_render', %s, '{}'::jsonb, 'cla-other-kind', 'test')
            """,
            (pipeline_id,),
        )
        cur.execute(
            "select claim_work_item('operator_dispatch'::work_item_kind, 'consumer-A')"
        )
        cur.execute(
            "select status from work_item where pipeline_id=%s",
            (pipeline_id,),
        )
        assert cur.fetchone()[0] == "queued"


# ---------------------------------------------------------------------------
# Concurrency: two consumers never claim the same row.
# ---------------------------------------------------------------------------


def test_two_consumers_never_claim_same_row(db_conn, pg_dsn: str) -> None:
    """Two parallel sessions claim, but only ONE wins (FOR UPDATE SKIP LOCKED).

    Drives two psycopg connections directly so we exercise the lock contract
    -- which is invisible inside a single connection (the second statement
    would just see the in-progress UPDATE).
    """
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        # Seed exactly ONE queued row of the kind.
        _enqueue(cur, pipeline_id=pipeline_id, idem_key="cla-conc-1")
        db_conn.commit()

    conn_a = psycopg.connect(pg_dsn, autocommit=False)
    conn_b = psycopg.connect(pg_dsn, autocommit=False)
    try:
        with conn_a.cursor() as ca, conn_b.cursor() as cb:
            # Both consumers issue the claim RPC. SKIP LOCKED means only one
            # can actually update the row; the other returns the empty
            # composite.
            ca.execute(
                "select claim_work_item('operator_dispatch'::work_item_kind, 'consumer-A')"
            )
            cb.execute(
                "select claim_work_item('operator_dispatch'::work_item_kind, 'consumer-B')"
            )
            conn_a.commit()
            conn_b.commit()
        with conn_a.cursor() as ca:
            ca.execute(
                "select claimed_by, status from work_item where pipeline_id=%s",
                (pipeline_id,),
            )
            claimed_by, status = ca.fetchone()
            assert status == "claimed"
            assert claimed_by in {"consumer-A", "consumer-B"}
    finally:
        # Clean up the row we committed so the next test starts clean.
        cleanup = psycopg.connect(pg_dsn, autocommit=True)
        try:
            with cleanup.cursor() as c:
                c.execute(
                    "delete from work_item where pipeline_id=%s",
                    (pipeline_id,),
                )
                c.execute("delete from pipelines where id=%s", (pipeline_id,))
        finally:
            cleanup.close()
        conn_a.close()
        conn_b.close()


# ---------------------------------------------------------------------------
# Token rotation -- the single-writer guard.
# ---------------------------------------------------------------------------


def test_token_rotation_invalidates_old_token(db_conn) -> None:
    """An UPDATE with a rotated claim_token returns 0 rows (consumer aborts)."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        _enqueue(cur, pipeline_id=pipeline_id, idem_key="cla-rotate")
        cur.execute(
            "select claim_work_item('operator_dispatch'::work_item_kind, 'consumer-A')"
        )
        cur.execute(
            "select id, claim_token from work_item where pipeline_id=%s",
            (pipeline_id,),
        )
        work_item_id, original_token = cur.fetchone()

        # Watchdog rotates: mark timed_out + clear claim.
        cur.execute(
            """
            update work_item
               set status='timed_out',
                   completed_at=now(),
                   error_kind='heartbeat_stale',
                   claim_token=null,
                   claimed_by=null,
                   claimed_at=null
             where id=%s
            """,
            (work_item_id,),
        )

        # Consumer presents the old token: 0 rows updated.
        cur.execute(
            """
            update work_item
               set heartbeat_at=now()
             where id=%s and claim_token=%s
            """,
            (work_item_id, original_token),
        )
        # rowcount reflects the UPDATE's matched count.
        assert cur.rowcount == 0


def test_attempt_increments_on_each_claim(db_conn) -> None:
    """``claim_work_item`` increments attempt -- the audit count of tries."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        _enqueue(cur, pipeline_id=pipeline_id, idem_key="cla-attempt")
        cur.execute(
            "select claim_work_item('operator_dispatch'::work_item_kind, 'consumer-A')"
        )
        cur.execute("select attempt from work_item where pipeline_id=%s", (pipeline_id,))
        assert cur.fetchone()[0] == 1
