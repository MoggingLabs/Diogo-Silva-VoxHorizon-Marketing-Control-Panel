"""Integration: the SQL pipeline_rollup_cleared() predicate (M2 / E2.3 / 0039).

Drives the single-authority gate predicate against a REAL Postgres with the
actual ``db/migrations/*.sql`` applied, proving the killed-creative DRIFT fix:

  * a stage with one in-scope creative that is `passed` -> cleared;
  * a `failed` in-scope creative -> NOT cleared (holds the gate);
  * a KILLED creative that is `failed` is DROPPED from the scope, so the stage is
    cleared when every *other* (in-scope) creative is cleared -- a killed creative
    must never hold the gate (the exact drift this migration fixes);
  * a stage with NO in-scope rows -> NOT cleared (the stage never ran);
  * if EVERY creative for the stage is killed -> NOT cleared (no in-scope rows).

The in-memory FakeSupabase double ignores the predicate entirely; this tier is
the net that proves the SQL actually drops killed creatives.
"""

from __future__ import annotations

import pytest


pytestmark = pytest.mark.integration


def _seed_image_creative(cur, brief_id: str, *, status: str = "draft") -> str:
    """Insert an image creative (mirrored into `creative` by the 0034 trigger)."""
    cur.execute(
        """
        insert into creatives (brief_id, type, concept, ratio, version, status)
        values (%s, 'image', 'concept', '1x1', 'v1.0', %s)
        returning id
        """,
        (brief_id, status),
    )
    return str(cur.fetchone()[0])


def _seed_gate(cur, pipeline_id: str, creative_id: str, stage: str, status: str) -> None:
    cur.execute(
        """
        insert into creative_stage_state (pipeline_id, creative_id, stage, status, decided_by)
        values (%s, %s, %s, %s, 'worker')
        """,
        (pipeline_id, creative_id, stage, status),
    )


def _rollup(cur, pipeline_id: str, stage: str) -> bool:
    cur.execute("select pipeline_rollup_cleared(%s, %s)", (pipeline_id, stage))
    return bool(cur.fetchone()[0])


def test_rollup_cleared_when_single_creative_passed(db_conn, image_creative) -> None:
    pid = image_creative["pipeline_id"]
    cid = image_creative["creative_id"]
    with db_conn.cursor() as cur:
        _seed_gate(cur, pid, cid, "creative_qa", "passed")
        assert _rollup(cur, pid, "creative_qa") is True


def test_rollup_blocked_when_creative_failed(db_conn, image_creative) -> None:
    pid = image_creative["pipeline_id"]
    cid = image_creative["creative_id"]
    with db_conn.cursor() as cur:
        _seed_gate(cur, pid, cid, "creative_qa", "failed")
        assert _rollup(cur, pid, "creative_qa") is False


def test_rollup_not_cleared_with_no_rows(db_conn, image_creative) -> None:
    pid = image_creative["pipeline_id"]
    with db_conn.cursor() as cur:
        assert _rollup(cur, pid, "creative_qa") is False


def test_killed_creative_does_not_hold_the_gate(db_conn, image_creative) -> None:
    """The drift fix: a KILLED `failed` creative is dropped, so the gate clears.

    One passed (in-scope) creative + one killed-and-failed creative. Pre-0039 the
    failed row held the gate; post-0039 the killed creative is out of scope, so the
    stage is cleared.
    """
    pid = image_creative["pipeline_id"]
    brief_id = image_creative["brief_id"]
    passed_cid = image_creative["creative_id"]
    with db_conn.cursor() as cur:
        killed_cid = _seed_image_creative(cur, brief_id, status="killed")
        _seed_gate(cur, pid, passed_cid, "creative_qa", "passed")
        _seed_gate(cur, pid, killed_cid, "creative_qa", "failed")
        assert _rollup(cur, pid, "creative_qa") is True


def test_all_killed_is_not_cleared(db_conn, image_creative) -> None:
    """If every creative for the stage is killed, there are zero in-scope rows -> not cleared."""
    pid = image_creative["pipeline_id"]
    brief_id = image_creative["brief_id"]
    with db_conn.cursor() as cur:
        # Kill the fixture creative too so the stage has no in-scope rows.
        cur.execute(
            "update creatives set status = 'killed' where id = %s",
            (image_creative["creative_id"],),
        )
        killed_cid = _seed_image_creative(cur, brief_id, status="killed")
        _seed_gate(cur, pid, image_creative["creative_id"], "creative_qa", "passed")
        _seed_gate(cur, pid, killed_cid, "creative_qa", "failed")
        assert _rollup(cur, pid, "creative_qa") is False


def test_soft_deleted_creative_dropped_from_scope(db_conn, image_creative) -> None:
    """A soft-deleted creative is out of scope (deleted_at on the base mirror)."""
    pid = image_creative["pipeline_id"]
    brief_id = image_creative["brief_id"]
    passed_cid = image_creative["creative_id"]
    with db_conn.cursor() as cur:
        deleted_cid = _seed_image_creative(cur, brief_id, status="draft")
        # Soft-delete via the base mirror (creative.deleted_at); the gate row stays.
        cur.execute(
            "update creative set deleted_at = now() where id = %s", (deleted_cid,)
        )
        _seed_gate(cur, pid, passed_cid, "creative_qa", "passed")
        _seed_gate(cur, pid, deleted_cid, "creative_qa", "failed")
        assert _rollup(cur, pid, "creative_qa") is True
