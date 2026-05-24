"""The foundation-bug proof: shared gate / evidence tables vs. both verticals.

This is the KEY test of the E0.1 integration tier (#421). It drives a creative
through the shared per-(creative, stage) gate + evidence writes against a REAL
Postgres with the actual ``db/migrations/*.sql`` applied, so the foreign keys
fire for real:

  * ``creative_stage_state.creative_id`` -> ``creatives(id)``   (0018)
  * ``compliance_finding.creative_id``   -> ``creatives(id)``   (0021)
  * ``qa_result.creative_id``            -> ``creatives(id)``   (0021)

All three reference ``creatives(id)`` ONLY. An IMAGE creative lives in
``creatives``, so its id writes cleanly -- the harness is provably correct
(:func:`test_image_creative_writes_gate_rows_pass`).

A VIDEO creative lives in ``video_creatives``; its id is NOT in ``creatives``,
so the same write is rejected with a foreign-key violation. That is THE
foundation bug -- the video pipeline (VID-12) routes video creatives through
these image-only shared tables. M1 (#448) broadens the references so a video
creative can own a gate row; until then the video write must fail. The video
tests are ``xfail(strict=True)`` asserting the write SUCCEEDS: today they fail
with the FK violation (-> xfail), and when M1 lands they pass (-> XPASS, a
strict-xfail failure) which is the signal to delete the markers.

The in-memory ``FakeSupabase`` double the unit suite uses ignores FKs entirely,
which is why this break shipped undetected; this tier is the net that catches
the next one.
"""

from __future__ import annotations

import pytest


pytestmark = pytest.mark.integration


M1_FIX = (
    "M1 (#448) broadens creative_stage_state / compliance_finding / qa_result to "
    "accept a video_creatives(id); until then a video creative_id violates the "
    "creatives(id)-only foreign key. When this XPASSes, M1 has landed -- remove "
    "the xfail."
)


def _fk_error():
    """The psycopg foreign-key violation class (lazy import for the skip path)."""
    from psycopg import errors

    return errors.ForeignKeyViolation


# ===========================================================================
# IMAGE side -- the harness is correct (these PASS today)
# ===========================================================================


def test_image_creative_writes_gate_rows_pass(db_conn, image_creative) -> None:
    """An IMAGE creative writes a gate row + both evidence rows cleanly.

    Proves the integration harness itself is sound: with the real schema and
    real FKs, the legitimate (image) path succeeds across all three shared
    tables. If THIS failed, the FK-violation video tests below would be
    meaningless.
    """
    pid = image_creative["pipeline_id"]
    cid = image_creative["creative_id"]

    with db_conn.cursor() as cur:
        # 1) creative_stage_state: the per-(creative, stage) gate row.
        cur.execute(
            """
            insert into creative_stage_state
              (pipeline_id, creative_id, stage, status, decided_by)
            values (%s, %s, 'compliance_review', 'passed', 'worker')
            returning id
            """,
            (pid, cid),
        )
        assert cur.fetchone()[0] is not None

        # 2) compliance_finding: append-only evidence (needs a real rule row).
        cur.execute(
            """
            insert into compliance_rule
              (rule_id, version, title, authority, surface, severity, citation_url)
            values ('test.rule', 1, 'Test rule', 'meta', 'copy', 'critical',
                    'https://example.test/rule')
            """
        )
        cur.execute(
            """
            insert into compliance_finding
              (pipeline_id, creative_id, rule_id, rule_version, severity, verdict,
               checked_by)
            values (%s, %s, 'test.rule', 1, 'critical', 'fail', 'worker')
            returning id
            """,
            (pid, cid),
        )
        assert cur.fetchone()[0] is not None

        # 3) qa_result: append-only QA evidence.
        cur.execute(
            """
            insert into qa_result
              (pipeline_id, creative_id, attempt, status, checked_by)
            values (%s, %s, 1, 'pass', 'worker')
            returning id
            """,
            (pid, cid),
        )
        assert cur.fetchone()[0] is not None


def test_image_compliance_finding_rule_version_is_text(db_conn, image_creative) -> None:
    """Sanity: compliance_finding.rule_version is TEXT post-0028/0030.

    The route persists the engine's semantic version verbatim ("2025.1" /
    "client"); a non-integer value must be accepted -- a regression here would
    silently 500 the live compliance route. compliance_finding dropped its
    composite FK to compliance_rule in 0027, so no rule row is needed.
    """
    pid = image_creative["pipeline_id"]
    cid = image_creative["creative_id"]
    with db_conn.cursor() as cur:
        cur.execute(
            """
            insert into compliance_finding
              (pipeline_id, creative_id, rule_id, rule_version, severity, verdict,
               checked_by)
            values (%s, %s, 'client.do_not_say.0', 'client', 'critical', 'fail',
                    'worker')
            returning rule_version
            """,
            (pid, cid),
        )
        assert cur.fetchone()[0] == "client"


# ===========================================================================
# VIDEO side -- the foundation bug (xfail until M1 / #448)
# ===========================================================================


@pytest.mark.xfail(reason=M1_FIX, strict=True, raises=Exception)
def test_video_creative_gate_row_currently_fk_violates(db_conn, video_creative) -> None:
    """KEY PROOF: a VIDEO creative cannot own a creative_stage_state gate row.

    The video creative_id is a real ``video_creatives(id)`` but not a
    ``creatives(id)``, so this gate write -- the exact write the shared
    compliance / QA route does for every adjudicated creative -- is rejected by
    ``creative_stage_state_creative_id_fkey``. Asserting the insert SUCCEEDS
    documents the post-M1 contract; today the FK violation makes it xfail.
    """
    pid = video_creative["pipeline_id"]
    cid = video_creative["creative_id"]  # a video_creatives(id), NOT a creatives(id)
    with db_conn.cursor() as cur:
        cur.execute(
            """
            insert into creative_stage_state
              (pipeline_id, creative_id, stage, status, decided_by)
            values (%s, %s, 'compliance_review', 'passed', 'worker')
            returning id
            """,
            (pid, cid),
        )
        # If M1 has broadened the FK, the row exists and this passes (-> XPASS).
        assert cur.fetchone()[0] is not None


@pytest.mark.xfail(reason=M1_FIX, strict=True, raises=Exception)
def test_video_creative_compliance_finding_currently_fk_violates(
    db_conn, video_creative
) -> None:
    """A VIDEO creative cannot own a compliance_finding evidence row either.

    Same root cause on the evidence side: ``compliance_finding.creative_id`` FKs
    ``creatives(id)`` only. The compliance route writes this evidence for every
    blocking finding, so video compliance evidence has no valid home pre-M1.
    """
    pid = video_creative["pipeline_id"]
    cid = video_creative["creative_id"]
    with db_conn.cursor() as cur:
        cur.execute(
            """
            insert into compliance_finding
              (pipeline_id, creative_id, rule_id, rule_version, severity, verdict,
               checked_by)
            values (%s, %s, 'meta.misleading_claim', '2025.1', 'critical', 'fail',
                    'worker')
            returning id
            """,
            (pid, cid),
        )
        assert cur.fetchone()[0] is not None


@pytest.mark.xfail(reason=M1_FIX, strict=True, raises=Exception)
def test_video_creative_qa_result_currently_fk_violates(db_conn, video_creative) -> None:
    """A VIDEO creative cannot own a qa_result evidence row either.

    ``qa_result.creative_id`` FKs ``creatives(id)`` only, so a video creative's
    QA attempt -- which the qa_run route appends for every adjudicated creative
    -- is rejected pre-M1.
    """
    pid = video_creative["pipeline_id"]
    cid = video_creative["creative_id"]
    with db_conn.cursor() as cur:
        cur.execute(
            """
            insert into qa_result
              (pipeline_id, creative_id, attempt, status, checked_by)
            values (%s, %s, 1, 'pass', 'worker')
            returning id
            """,
            (pid, cid),
        )
        assert cur.fetchone()[0] is not None


def test_video_creative_gate_row_raises_foreign_key_violation(
    db_conn, video_creative
) -> None:
    """Pin the EXACT failure mode: a ForeignKeyViolation naming the gate FK.

    The xfail tests above prove the write fails; this one asserts WHY -- a real
    ``psycopg.errors.ForeignKeyViolation`` on the creatives(id) reference -- so
    the documented break can't quietly mutate into some other error. This test
    is expected to keep PASSING until M1; once M1 lands it will need updating
    alongside the xfail removals (the insert will no longer raise).
    """
    pid = video_creative["pipeline_id"]
    cid = video_creative["creative_id"]
    with pytest.raises(_fk_error()) as exc_info:
        with db_conn.cursor() as cur:
            cur.execute(
                """
                insert into creative_stage_state
                  (pipeline_id, creative_id, stage, status, decided_by)
                values (%s, %s, 'compliance_review', 'passed', 'worker')
                """,
                (pid, cid),
            )
    # The violation must name the creatives(id) reference, not some other FK.
    assert "creative" in str(exc_info.value).lower()
