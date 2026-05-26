"""DB-backed tests for ``pipeline_cancel_propagate_to_work_items``.

When ``pipeline_events(kind='pipeline_cancelled')`` is inserted, the
trigger cancels every open work_item for the pipeline in one SQL
statement. This is how the cancel route stays a pure event emitter and
in-flight work never keeps writing after a pipeline is cancelled.

Pins:
  * Open rows (queued / claimed / running) become 'cancelled' with
    error_kind='pipeline_cancelled' and the claim cleared.
  * Terminal rows (completed / failed / timed_out / cancelled) are
    UNTOUCHED.
  * Rows on OTHER pipelines are unaffected.
"""

from __future__ import annotations

import pytest


pytestmark = pytest.mark.integration


def _seed_pipeline(cur, suffix: str = "") -> str:
    cur.execute(
        """
        insert into clients (slug, name, service_type)
        values ('cp-' || substr(md5(random()::text), 1, 8) || %s,
                'Cancel Test', 'roofing')
        returning id
        """,
        (suffix,),
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


def _enqueue(cur, *, pipeline_id: str, idem_key: str) -> str:
    cur.execute(
        """
        insert into work_item (kind, pipeline_id, payload, idempotency_key, created_by)
        values ('operator_dispatch', %s, '{}'::jsonb, %s, 'test')
        returning id
        """,
        (pipeline_id, idem_key),
    )
    return str(cur.fetchone()[0])


def test_cancel_propagates_to_queued_row(db_conn) -> None:
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        wi = _enqueue(cur, pipeline_id=pipeline_id, idem_key="cp-q-1")
        cur.execute(
            """
            insert into pipeline_events (pipeline_id, kind, payload)
            values (%s, 'pipeline_cancelled', '{}'::jsonb)
            """,
            (pipeline_id,),
        )
        cur.execute(
            "select status, error_kind, claim_token from work_item where id=%s",
            (wi,),
        )
        row = cur.fetchone()
        assert row[0] == "cancelled"
        assert row[1] == "pipeline_cancelled"
        assert row[2] is None


def test_cancel_propagates_to_claimed_row(db_conn) -> None:
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur)
        wi = _enqueue(cur, pipeline_id=pipeline_id, idem_key="cp-c-1")
        cur.execute(
            """
            update work_item
               set status='claimed',
                   claim_token=gen_random_uuid(),
                   claimed_by='c-1', claimed_at=now()
             where id=%s
            """,
            (wi,),
        )
        cur.execute(
            """
            insert into pipeline_events (pipeline_id, kind, payload)
            values (%s, 'pipeline_cancelled', '{}'::jsonb)
            """,
            (pipeline_id,),
        )
        cur.execute(
            "select status, error_kind, claim_token from work_item where id=%s",
            (wi,),
        )
        row = cur.fetchone()
        assert row[0] == "cancelled"
        assert row[1] == "pipeline_cancelled"
        # Trigger clears the claim so the next watchdog tick doesn't try to
        # rotate it.
        assert row[2] is None


def test_terminal_rows_untouched(db_conn) -> None:
    """Already-completed rows are NOT re-cancelled."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur, suffix="-term")
        wi = _enqueue(cur, pipeline_id=pipeline_id, idem_key="cp-t-1")
        # Drive to claimed -> running -> completed.
        cur.execute(
            """
            update work_item
               set status='claimed',
                   claim_token=gen_random_uuid(),
                   claimed_by='c-1', claimed_at=now()
             where id=%s
            """,
            (wi,),
        )
        cur.execute(
            "update work_item set status='running', heartbeat_at=now() where id=%s",
            (wi,),
        )
        cur.execute(
            """
            update work_item
               set status='completed', completed_at=now(),
                   claim_token=null, claimed_by=null, claimed_at=null
             where id=%s
            """,
            (wi,),
        )
        cur.execute(
            """
            insert into pipeline_events (pipeline_id, kind, payload)
            values (%s, 'pipeline_cancelled', '{}'::jsonb)
            """,
            (pipeline_id,),
        )
        cur.execute(
            "select status, error_kind from work_item where id=%s", (wi,)
        )
        row = cur.fetchone()
        # Status stays 'completed' -- the cancel does NOT overwrite terminal.
        assert row[0] == "completed"
        # error_kind was never set on the happy path.
        assert row[1] is None


def test_cancel_does_not_affect_other_pipelines(db_conn) -> None:
    """A cancel event for pipeline A leaves pipeline B's open rows untouched."""
    with db_conn.cursor() as cur:
        pa = _seed_pipeline(cur, suffix="-pa")
        pb = _seed_pipeline(cur, suffix="-pb")
        wi_a = _enqueue(cur, pipeline_id=pa, idem_key="cp-iso-a")
        wi_b = _enqueue(cur, pipeline_id=pb, idem_key="cp-iso-b")
        cur.execute(
            """
            insert into pipeline_events (pipeline_id, kind, payload)
            values (%s, 'pipeline_cancelled', '{}'::jsonb)
            """,
            (pa,),
        )
        cur.execute("select status from work_item where id=%s", (wi_a,))
        assert cur.fetchone()[0] == "cancelled"
        cur.execute("select status from work_item where id=%s", (wi_b,))
        assert cur.fetchone()[0] == "queued"


def test_non_cancel_event_does_not_propagate(db_conn) -> None:
    """An ``operator_completed`` event does NOT cancel work_items."""
    with db_conn.cursor() as cur:
        pipeline_id = _seed_pipeline(cur, suffix="-non")
        wi = _enqueue(cur, pipeline_id=pipeline_id, idem_key="cp-non-1")
        cur.execute(
            """
            insert into pipeline_events (pipeline_id, kind, payload)
            values (%s, 'stage_advanced', '{}'::jsonb)
            """,
            (pipeline_id,),
        )
        cur.execute("select status from work_item where id=%s", (wi,))
        assert cur.fetchone()[0] == "queued"
