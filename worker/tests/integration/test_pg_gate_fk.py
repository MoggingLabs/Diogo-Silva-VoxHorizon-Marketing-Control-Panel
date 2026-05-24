"""Foundation gate test: shared gate / evidence tables vs. both verticals.

This is the KEY test of the E0.1 integration tier (#421). It drives a creative
through the shared per-(creative, stage) gate + evidence writes against a REAL
Postgres with the actual ``db/migrations/*.sql`` applied, so the foreign keys
fire for real:

  * ``creative_stage_state.creative_id`` -> ``creative(id)``  (repointed 0035)
  * ``compliance_finding.creative_id``   -> ``creative(id)``  (repointed 0035)
  * ``qa_result.creative_id``            -> ``creative(id)``  (repointed 0035)

Before M1 (#448) these referenced ``creatives(id)`` ONLY, so a VIDEO creative
(which lives in ``video_creatives``) could never own a gate row -- the FK
rejected it. That was the foundation bug. M1 introduced a neutral ``creative``
identity (0034): every ``creatives`` / ``video_creatives`` row is mirrored to a
``creative`` base row (by id + format), and the shared tables were repointed to
``creative(id)`` (0035). So BOTH verticals now own gate + evidence rows.

The in-memory ``FakeSupabase`` double the unit suite uses ignores FKs entirely,
which is why the break shipped undetected; this tier is the net that catches the
next one.
"""

from __future__ import annotations

import pytest


pytestmark = pytest.mark.integration


# ===========================================================================
# IMAGE side -- the legitimate path, always valid.
# ===========================================================================


def test_image_creative_writes_gate_rows_pass(db_conn, image_creative) -> None:
    """An IMAGE creative writes a gate row + both evidence rows cleanly.

    Proves the integration harness itself is sound: with the real schema and
    real FKs, the image path succeeds across all three shared tables.
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
# VIDEO side -- M1 (#448) fixed the foundation: a video creative is mirrored
# into the neutral `creative` base (0034) and the shared tables FK `creative(id)`
# (0035), so it now owns gate + evidence rows exactly like an image creative.
# (Before M1 these were xfail(strict) FK-violation proofs.)
# ===========================================================================


def test_video_creative_has_mirrored_base_row(db_conn, video_creative) -> None:
    """0034: seeding a video_creatives row mirrors a `creative` base row.

    The AFTER INSERT trigger creates a `creative` row with the same id and
    format='video', which is what lets the shared FKs accept the video id.
    """
    cid = video_creative["creative_id"]
    with db_conn.cursor() as cur:
        cur.execute("select format from creative where id = %s", (cid,))
        row = cur.fetchone()
    assert row is not None, "video creative was not mirrored into the creative base"
    assert row[0] == "video"


def test_video_creative_writes_gate_row(db_conn, video_creative) -> None:
    """A VIDEO creative now owns a creative_stage_state gate row (post-M1).

    This is the exact write the shared compliance / QA route does for every
    adjudicated creative; before M1 it was rejected by the creatives(id)-only FK.
    """
    pid = video_creative["pipeline_id"]
    cid = video_creative["creative_id"]  # a video_creatives(id), mirrored into creative
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
        assert cur.fetchone()[0] is not None


def test_video_creative_writes_compliance_finding(db_conn, video_creative) -> None:
    """A VIDEO creative now owns a compliance_finding evidence row (post-M1)."""
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


def test_video_creative_writes_qa_result(db_conn, video_creative) -> None:
    """A VIDEO creative now owns a qa_result evidence row (post-M1)."""
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
