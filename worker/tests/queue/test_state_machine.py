"""DB-backed tests for the work_item state machine + CHECK invariants.

Drives migration 0050 directly via psycopg so every CHECK constraint actually
fires. Each invariant the migration encodes maps to one named test:

  * ``work_item_claim_consistent``      -> can't claim without a token /
                                          can't leave a stale token on a
                                          queued or terminal row.
  * ``work_item_running_heartbeated``   -> can't be running without a
                                          heartbeat_at.
  * ``work_item_terminal_closed``       -> can't be terminal without
                                          completed_at + cleared claim.
  * ``work_item_failure_explained``     -> can't fail without naming
                                          error_kind.

These are SCHEMA tests, not facade tests: the assertion is that the DB
rejects the bad payload, so an in-process bug or a regression on the
facade itself cannot ship a defective row by accident.
"""

from __future__ import annotations

import pytest
import psycopg


pytestmark = pytest.mark.integration


def _seed_pipeline(cur) -> str:
    """Seed minimal pipeline + client so work_item.pipeline_id has a target."""
    cur.execute(
        """
        insert into clients (slug, name, service_type)
        values ('wq-' || substr(md5(random()::text), 1, 8),
                'WQ Test Client', 'roofing')
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


def _insert_queued(cur, *, pipeline_id: str, idem_key: str | None = None) -> str:
    """Insert one healthy queued row and return its id."""
    cur.execute(
        """
        insert into work_item (kind, pipeline_id, payload, idempotency_key, created_by)
        values ('operator_dispatch', %s, '{}'::jsonb, %s, 'test')
        returning id
        """,
        (pipeline_id, idem_key or f"k-{psycopg.types.uuid.UUID.hex}"),
    )
    return str(cur.fetchone()[0])


# ---------------------------------------------------------------------------
# work_item_claim_consistent
# ---------------------------------------------------------------------------


def test_queued_row_with_claim_token_rejected(db_conn) -> None:
    """A row in status='queued' MUST NOT hold a claim_token."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        with pytest.raises(psycopg.errors.CheckViolation) as exc:
            cur.execute(
                """
                insert into work_item
                  (kind, pipeline_id, status, payload, idempotency_key,
                   created_by, claim_token, claimed_by, claimed_at)
                values ('operator_dispatch', %s, 'queued', '{}'::jsonb,
                        'sm-1', 'test',
                        gen_random_uuid(), 'consumer-1', now())
                """,
                (pipeline_id,),
            )
        assert "work_item_claim_consistent" in str(exc.value)
        db_conn.rollback()


def test_claimed_row_without_token_rejected(db_conn) -> None:
    """A row in status='claimed' MUST hold a claim_token + claimed_by + at."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        with pytest.raises(psycopg.errors.CheckViolation) as exc:
            cur.execute(
                """
                insert into work_item
                  (kind, pipeline_id, status, payload, idempotency_key, created_by)
                values ('operator_dispatch', %s, 'claimed', '{}'::jsonb,
                        'sm-2', 'test')
                """,
                (pipeline_id,),
            )
        assert "work_item_claim_consistent" in str(exc.value)
        db_conn.rollback()


def test_terminal_row_with_claim_token_rejected(db_conn) -> None:
    """A terminal (completed/failed/timed_out/cancelled) row MUST clear the claim."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        with pytest.raises(psycopg.errors.CheckViolation) as exc:
            cur.execute(
                """
                insert into work_item
                  (kind, pipeline_id, status, completed_at, payload,
                   idempotency_key, created_by, claim_token, claimed_by, claimed_at)
                values ('operator_dispatch', %s, 'completed', now(),
                        '{}'::jsonb, 'sm-3', 'test',
                        gen_random_uuid(), 'consumer-1', now())
                """,
                (pipeline_id,),
            )
        assert "work_item_claim_consistent" in str(exc.value)
        db_conn.rollback()


# ---------------------------------------------------------------------------
# work_item_running_heartbeated
# ---------------------------------------------------------------------------


def test_running_row_without_heartbeat_rejected(db_conn) -> None:
    """A row in status='running' MUST carry a heartbeat_at."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        with pytest.raises(psycopg.errors.CheckViolation) as exc:
            cur.execute(
                """
                insert into work_item
                  (kind, pipeline_id, status, payload, idempotency_key,
                   created_by, claim_token, claimed_by, claimed_at)
                values ('operator_dispatch', %s, 'running', '{}'::jsonb,
                        'sm-4', 'test',
                        gen_random_uuid(), 'consumer-1', now())
                """,
                (pipeline_id,),
            )
        assert "work_item_running_heartbeated" in str(exc.value)
        db_conn.rollback()


# ---------------------------------------------------------------------------
# work_item_terminal_closed
# ---------------------------------------------------------------------------


def test_completed_row_without_completed_at_rejected(db_conn) -> None:
    """A terminal row MUST carry completed_at."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        with pytest.raises(psycopg.errors.CheckViolation) as exc:
            cur.execute(
                """
                insert into work_item
                  (kind, pipeline_id, status, payload, idempotency_key, created_by)
                values ('operator_dispatch', %s, 'completed', '{}'::jsonb,
                        'sm-5', 'test')
                """,
                (pipeline_id,),
            )
        assert "work_item_terminal_closed" in str(exc.value)
        db_conn.rollback()


# ---------------------------------------------------------------------------
# work_item_failure_explained
# ---------------------------------------------------------------------------


def test_failed_row_without_error_kind_rejected(db_conn) -> None:
    """A failed/timed_out row MUST name error_kind."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        with pytest.raises(psycopg.errors.CheckViolation) as exc:
            cur.execute(
                """
                insert into work_item
                  (kind, pipeline_id, status, completed_at, payload,
                   idempotency_key, created_by)
                values ('operator_dispatch', %s, 'failed', now(),
                        '{}'::jsonb, 'sm-6', 'test')
                """,
                (pipeline_id,),
            )
        assert "work_item_failure_explained" in str(exc.value)
        db_conn.rollback()


def test_timed_out_row_without_error_kind_rejected(db_conn) -> None:
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        with pytest.raises(psycopg.errors.CheckViolation) as exc:
            cur.execute(
                """
                insert into work_item
                  (kind, pipeline_id, status, completed_at, payload,
                   idempotency_key, created_by)
                values ('operator_dispatch', %s, 'timed_out', now(),
                        '{}'::jsonb, 'sm-7', 'test')
                """,
                (pipeline_id,),
            )
        assert "work_item_failure_explained" in str(exc.value)
        db_conn.rollback()


# ---------------------------------------------------------------------------
# Round-trip every legal transition (queued -> claimed -> running -> completed)
# ---------------------------------------------------------------------------


def test_full_legal_lifecycle_completed(db_conn) -> None:
    """queued -> claimed -> running -> completed transitions all pass."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        cur.execute(
            """
            insert into work_item (kind, pipeline_id, payload, idempotency_key, created_by)
            values ('operator_dispatch', %s, '{}'::jsonb, 'sm-rt-1', 'test')
            returning id
            """,
            (pipeline_id,),
        )
        work_item_id = cur.fetchone()[0]

        # queued -> claimed
        cur.execute(
            """
            update work_item
               set status='claimed',
                   claim_token=gen_random_uuid(),
                   claimed_by='c-1',
                   claimed_at=now()
             where id=%s
            """,
            (work_item_id,),
        )

        # claimed -> running (must stamp heartbeat_at)
        cur.execute(
            """
            update work_item
               set status='running', heartbeat_at=now()
             where id=%s
            """,
            (work_item_id,),
        )

        # running -> completed (must clear claim + set completed_at)
        cur.execute(
            """
            update work_item
               set status='completed', completed_at=now(),
                   claim_token=null, claimed_by=null, claimed_at=null
             where id=%s
            """,
            (work_item_id,),
        )
        cur.execute("select status from work_item where id=%s", (work_item_id,))
        assert cur.fetchone()[0] == "completed"


def test_full_legal_lifecycle_failed(db_conn) -> None:
    """A failure path with a named error_kind passes the invariants."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        cur.execute(
            """
            insert into work_item (kind, pipeline_id, payload, idempotency_key, created_by)
            values ('operator_dispatch', %s, '{}'::jsonb, 'sm-rt-2', 'test')
            returning id
            """,
            (pipeline_id,),
        )
        work_item_id = cur.fetchone()[0]
        cur.execute(
            """
            update work_item
               set status='claimed',
                   claim_token=gen_random_uuid(),
                   claimed_by='c-1',
                   claimed_at=now()
             where id=%s
            """,
            (work_item_id,),
        )
        cur.execute(
            """
            update work_item
               set status='failed', completed_at=now(),
                   error_kind='auth_expired',
                   claim_token=null, claimed_by=null, claimed_at=null
             where id=%s
            """,
            (work_item_id,),
        )
        cur.execute(
            "select status, error_kind from work_item where id=%s",
            (work_item_id,),
        )
        row = cur.fetchone()
        assert row[0] == "failed"
        assert row[1] == "auth_expired"


def test_idempotency_key_unique(db_conn) -> None:
    """Two rows with the same idempotency_key conflict (the dedup invariant)."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        cur.execute(
            """
            insert into work_item (kind, pipeline_id, payload, idempotency_key, created_by)
            values ('operator_dispatch', %s, '{}'::jsonb, 'sm-uniq', 'test')
            """,
            (pipeline_id,),
        )
        with pytest.raises(psycopg.errors.UniqueViolation):
            cur.execute(
                """
                insert into work_item (kind, pipeline_id, payload, idempotency_key, created_by)
                values ('operator_dispatch', %s, '{}'::jsonb, 'sm-uniq', 'test')
                """,
                (pipeline_id,),
            )
        db_conn.rollback()
