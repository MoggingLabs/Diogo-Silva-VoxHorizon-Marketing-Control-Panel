"""DB-backed tests for the FIX-D copy compliance re-arm scoping (migration 0055).

The 0025 trigger ``copy_variants_rearm_compliance`` fired on EVERY copy_variants
insert AND update, so a status-only APPROVE UPDATE (status -> 'approved') re-armed
the creative's compliance_review gate back to 'pending'. Nothing re-adjudicates on
a copy-stage write, so the downstream launch_handoff gate then silently blocked
the launch. 0055 re-scopes the re-arm to fire on INSERT and on a CONTENT-changing
UPDATE only, NOT on a status-only verdict UPDATE.

These tests pin the new firing semantics against a REAL Postgres with the actual
``db/migrations/*.sql`` applied (so the trigger fires for real):

  * a fresh copy draft (INSERT) re-arms compliance_review to 'pending';
  * approving a draft (status-only UPDATE to 'approved') does NOT re-arm;
  * rejecting a draft (status-only UPDATE to 'rejected') does NOT re-arm;
  * editing a draft's TEXT (content-column UPDATE) re-arms;
  * a humanize-only UPDATE (no content-column change) does NOT re-arm;
  * video_copy_variants still carries no re-arm trigger (video immunity).

The in-memory ``FakeSupabase`` double the unit suite uses ignores triggers
entirely, which is why the over-broad re-arm shipped undetected; this DB tier is
the net that catches it.
"""

from __future__ import annotations

import pytest


pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Helpers: seed a creative + its compliance gate + one copy draft, and read the
# gate status back. The ``image_creative`` fixture (tests/db_fixtures.py) already
# seeds client + brief + pipeline + an image creative mirrored into ``creative``.
# ---------------------------------------------------------------------------


def _seed_cleared_compliance_gate(cur, pipeline_id: str, creative_id: str) -> None:
    """Seed a NON-pending (cleared) compliance_review gate for the creative.

    The re-arm only touches a row whose status <> 'pending' (0025 idempotency),
    so the gate must start in a terminal-good state for "re-armed -> pending" to
    be observable. We use 'passed' (a fresh worker clearance).
    """
    cur.execute(
        """
        insert into creative_stage_state
          (pipeline_id, creative_id, stage, status, decided_by)
        values (%s, %s, 'compliance_review', 'passed', 'worker')
        """,
        (pipeline_id, creative_id),
    )


def _gate_status(cur, creative_id: str) -> str:
    cur.execute(
        """
        select status::text from creative_stage_state
         where creative_id = %s and stage = 'compliance_review'
        """,
        (creative_id,),
    )
    return cur.fetchone()[0]


def _insert_draft(cur, pipeline_id: str, creative_id: str, *, variant_index: int = 1) -> str:
    cur.execute(
        """
        insert into copy_variants
          (pipeline_id, creative_id, platform, variant_index, headline, body,
           description, cta, status)
        values (%s, %s, 'meta', %s, 'Fresh roof now', 'Free inspection this week',
                'Limited slots', 'Book now', 'draft')
        returning id
        """,
        (pipeline_id, creative_id, variant_index),
    )
    return str(cur.fetchone()[0])


# ---------------------------------------------------------------------------
# INSERT (a fresh draft) re-arms compliance to pending.
# ---------------------------------------------------------------------------


def test_insert_draft_rearms_compliance(db_conn, image_creative) -> None:
    pid = image_creative["pipeline_id"]
    cid = image_creative["creative_id"]
    with db_conn.cursor() as cur:
        _seed_cleared_compliance_gate(cur, pid, cid)
        assert _gate_status(cur, cid) == "passed"  # cleared before the draft

        _insert_draft(cur, pid, cid)

        # A fresh draft IS new content -> the prior verdict is voided.
        assert _gate_status(cur, cid) == "pending"


# ---------------------------------------------------------------------------
# Status-only APPROVE UPDATE does NOT re-arm (the FIX-D regression).
# ---------------------------------------------------------------------------


def test_approve_draft_does_not_rearm_compliance(db_conn, image_creative) -> None:
    """The exact /copy/decision approve write: status -> 'approved' + stamps,
    NO content-column change. The compliance gate must STAY cleared."""
    pid = image_creative["pipeline_id"]
    cid = image_creative["creative_id"]
    with db_conn.cursor() as cur:
        variant_id = _insert_draft(cur, pid, cid)
        # The insert above re-armed the gate; re-clear it (the worker's fresh
        # adjudication of the draft), so we can observe whether the APPROVE
        # re-arms it again (the bug) or leaves it cleared (the fix).
        cur.execute(
            """
            update creative_stage_state
               set status = 'passed', decided_by = 'worker'
             where creative_id = %s and stage = 'compliance_review'
            """,
            (cid,),
        )
        assert _gate_status(cur, cid) == "passed"

        # Byte-for-byte the approve UPDATE the decision route issues.
        cur.execute(
            """
            update copy_variants
               set status = 'approved',
                   approved_by = 'operator',
                   approved_at = now(),
                   decided_notes = null,
                   updated_at = now()
             where id = %s
            """,
            (variant_id,),
        )

        # No content changed -> NO re-arm -> launch is not silently blocked.
        assert _gate_status(cur, cid) == "passed"


def test_reject_draft_does_not_rearm_compliance(db_conn, image_creative) -> None:
    """Reject is also a status-only verdict UPDATE: it must not re-arm either."""
    pid = image_creative["pipeline_id"]
    cid = image_creative["creative_id"]
    with db_conn.cursor() as cur:
        variant_id = _insert_draft(cur, pid, cid)
        cur.execute(
            """
            update creative_stage_state
               set status = 'passed', decided_by = 'worker'
             where creative_id = %s and stage = 'compliance_review'
            """,
            (cid,),
        )
        assert _gate_status(cur, cid) == "passed"

        cur.execute(
            """
            update copy_variants
               set status = 'rejected',
                   decided_notes = 'off-brand',
                   updated_at = now()
             where id = %s
            """,
            (variant_id,),
        )

        assert _gate_status(cur, cid) == "passed"


# ---------------------------------------------------------------------------
# A content-changing UPDATE (editing draft text) DOES re-arm -- the
# void-on-content-change intent of 0025 is preserved.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("column", "new_value"),
    [
        ("headline", "Brand new headline"),
        ("body", "Completely different primary text"),
        ("description", "A different description line"),
        ("cta", "Call today"),
        ("pattern", "scarcity-v2"),
    ],
)
def test_content_edit_update_rearms_compliance(
    db_conn, image_creative, column: str, new_value: str
) -> None:
    pid = image_creative["pipeline_id"]
    cid = image_creative["creative_id"]
    with db_conn.cursor() as cur:
        variant_id = _insert_draft(cur, pid, cid)
        cur.execute(
            """
            update creative_stage_state
               set status = 'passed', decided_by = 'worker'
             where creative_id = %s and stage = 'compliance_review'
            """,
            (cid,),
        )
        assert _gate_status(cur, cid) == "passed"

        # Edit one copy CONTENT column (as the copy editor routes do, which also
        # reset status -> 'draft'); the live copy no longer matches the prior
        # verdict, so it MUST re-arm.
        cur.execute(
            f"update copy_variants set {column} = %s, status = 'draft', updated_at = now() where id = %s",  # noqa: S608 - column is from a fixed test-controlled allowlist
            (new_value, variant_id),
        )

        assert _gate_status(cur, cid) == "pending"


def test_humanize_only_update_does_not_rearm_compliance(db_conn, image_creative) -> None:
    """A humanize-only toggle changes no adjudicated content column, so it does
    NOT void a prior verdict (``humanized`` is intentionally excluded from the
    content set)."""
    pid = image_creative["pipeline_id"]
    cid = image_creative["creative_id"]
    with db_conn.cursor() as cur:
        variant_id = _insert_draft(cur, pid, cid)
        cur.execute(
            """
            update creative_stage_state
               set status = 'passed', decided_by = 'worker'
             where creative_id = %s and stage = 'compliance_review'
            """,
            (cid,),
        )
        assert _gate_status(cur, cid) == "passed"

        cur.execute(
            "update copy_variants set humanized = true, humanized_at = now(), updated_at = now() where id = %s",
            (variant_id,),
        )

        assert _gate_status(cur, cid) == "passed"


# ---------------------------------------------------------------------------
# Scope: one creative's copy write never disturbs another creative's gate.
# ---------------------------------------------------------------------------


def test_rearm_is_scoped_to_the_affected_creative(db_conn, image_creative) -> None:
    pid = image_creative["pipeline_id"]
    cid = image_creative["creative_id"]
    with db_conn.cursor() as cur:
        # A second creative on the same brief, with its own cleared gate.
        cur.execute(
            """
            insert into creatives (brief_id, type, concept, ratio, version, status)
            values (%s, 'image', 'other-roof', '1x1', 'v1.0', 'draft')
            returning id
            """,
            (image_creative["brief_id"],),
        )
        other_cid = str(cur.fetchone()[0])
        _seed_cleared_compliance_gate(cur, pid, other_cid)

        # Insert a draft for the FIRST creative (re-arms only its own gate).
        _insert_draft(cur, pid, cid)

        # The other creative's gate is untouched.
        assert _gate_status(cur, other_cid) == "passed"


# ---------------------------------------------------------------------------
# Video immunity: video_copy_variants carries NO re-arm trigger.
# ---------------------------------------------------------------------------


def test_video_copy_variants_has_no_rearm_trigger(db_conn) -> None:
    """0055 (like 0025 before it) only touches copy_variants. The video parity
    table must carry no compliance re-arm trigger -- video stays immune."""
    with db_conn.cursor() as cur:
        cur.execute(
            """
            select count(*)
              from pg_trigger t
              join pg_class c on c.oid = t.tgrelid
             where c.relname = 'video_copy_variants'
               and not t.tgisinternal
               and t.tgfoid = 'compliance_rearm_on_copy_change'::regproc
            """
        )
        assert cur.fetchone()[0] == 0
