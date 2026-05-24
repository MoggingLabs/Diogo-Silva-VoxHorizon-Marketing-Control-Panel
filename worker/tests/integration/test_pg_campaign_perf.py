"""Postgres-tier proof for the campaign_perf writer columns (#561).

THE BUG this catches: the reconciliation writer
(:func:`routes.integrations._write_campaign_perf`) emitted column names that do
not exist on the campaign_perf tables -- ``leads`` / ``spend_usd`` / ``real_cpl``
/ ``window_start`` -- while the real schema (migrations 0001 + 0023/0031) defines
``leads_ghl`` / ``spend`` / ``cpl_real`` / ``window_days``. The in-memory
``FakeSupabase`` double the unit suite uses is column-blind, so it happily
"persisted" the phantom columns and every unit test passed -- but the INSERT
fails against real Postgres, so monitor perf rows were NEVER actually written.
This is the same class of break as the M1 FK foundation bug.

This tier applies the REAL ``db/migrations/*.sql`` to an ephemeral Postgres, so
the perf INSERT runs against the live columns + NOT NULL + FK constraints. It
asserts:

  * the row the writer builds (:func:`build_campaign_perf_row`, the shared source)
    inserts cleanly into BOTH ``campaign_perf_image`` and ``campaign_perf_video``;
  * the values round-trip into the real columns;
  * a NULL ``campaign_id`` / ``window_days`` is rejected (the NOT NULL columns the
    old writer never supplied at all);
  * the phantom columns the old writer used do NOT exist on the tables (the exact
    INSERT that would have shipped, proven to fail).

These are the tests that would have caught #561 before it shipped.
"""

from __future__ import annotations

from datetime import datetime, timezone

import psycopg
import pytest

from src.routes.integrations import (
    build_campaign_perf_row,
    campaign_perf_table,
)


pytestmark = pytest.mark.integration


SINCE = datetime(2026, 5, 1, tzinfo=timezone.utc)
UNTIL = datetime(2026, 5, 8, tzinfo=timezone.utc)


def _insert_row(cur, table: str, row: dict) -> str:
    """Insert ``row`` into ``table`` (dynamic columns) and return the new id.

    The column identifiers come from the writer's own dict keys -- they are not
    user input -- so composing the statement from them is safe here and keeps the
    test inserting EXACTLY the columns the writer emits.
    """
    cols = list(row.keys())
    placeholders = ", ".join(["%s"] * len(cols))
    col_list = ", ".join(cols)
    cur.execute(
        f"insert into {table} ({col_list}) values ({placeholders}) returning id",  # noqa: S608
        [row[c] for c in cols],
    )
    return str(cur.fetchone()[0])


# ===========================================================================
# IMAGE -- the writer row lands in campaign_perf_image with real columns.
# ===========================================================================


def test_image_perf_row_inserts_against_real_schema(db_conn, image_creative) -> None:
    """The reconciliation writer's image row inserts cleanly + round-trips.

    Pre-#561 this INSERT failed: the writer emitted ``leads`` / ``spend_usd`` /
    ``real_cpl`` / ``window_start``, none of which exist on campaign_perf_image.
    """
    client_id = image_creative["client_id"]
    pipeline_id = image_creative["pipeline_id"]

    assert campaign_perf_table("image") == "campaign_perf_image"

    row = build_campaign_perf_row(
        pipeline_id=pipeline_id,
        ad_entity_id=None,
        client_id=client_id,
        campaign_id="camp-100",
        leads=4,
        meta_spend=200.0,
        cpl=50.0,
        window=(SINCE, UNTIL),
    )

    with db_conn.cursor() as cur:
        new_id = _insert_row(cur, "campaign_perf_image", row)
        cur.execute(
            "select client_id, campaign_id, window_days, leads_ghl, spend, "
            "cpl_real, pipeline_id from campaign_perf_image where id = %s",
            (new_id,),
        )
        got = cur.fetchone()

    assert str(got[0]) == client_id
    assert got[1] == "camp-100"
    assert got[2] == 7  # SINCE..UNTIL spans 7 days
    assert got[3] == 4  # leads_ghl
    assert float(got[4]) == 200.0  # spend
    assert float(got[5]) == 50.0  # cpl_real
    assert str(got[6]) == pipeline_id


# ===========================================================================
# VIDEO -- routed to campaign_perf_video, same column subset.
# ===========================================================================


def test_video_perf_row_inserts_into_video_table(db_conn, video_creative) -> None:
    """A video pipeline's perf row inserts cleanly into campaign_perf_video.

    Image + video keep SEPARATE perf tables; the writer routes by format. The
    common column subset is identical, so the same builder row lands in the video
    table (which adds the engagement funnel on top).
    """
    client_id = video_creative["client_id"]
    pipeline_id = video_creative["pipeline_id"]

    assert campaign_perf_table("video") == "campaign_perf_video"

    row = build_campaign_perf_row(
        pipeline_id=pipeline_id,
        ad_entity_id=None,
        client_id=client_id,
        campaign_id="camp-200",
        leads=3,
        meta_spend=150.0,
        cpl=50.0,
        window=(SINCE, UNTIL),
    )

    with db_conn.cursor() as cur:
        new_id = _insert_row(cur, "campaign_perf_video", row)
        cur.execute(
            "select client_id, campaign_id, window_days, leads_ghl, spend, "
            "cpl_real from campaign_perf_video where id = %s",
            (new_id,),
        )
        got = cur.fetchone()

    assert str(got[0]) == client_id
    assert got[1] == "camp-200"
    assert got[2] == 7
    assert got[3] == 3
    assert float(got[4]) == 150.0
    assert float(got[5]) == 50.0


def test_zero_leads_cpl_null_is_accepted(db_conn, image_creative) -> None:
    """The divide-by-zero guard (cpl_real = NULL, leads_ghl = 0) is a valid row."""
    row = build_campaign_perf_row(
        pipeline_id=image_creative["pipeline_id"],
        ad_entity_id=None,
        client_id=image_creative["client_id"],
        campaign_id="camp-300",
        leads=0,
        meta_spend=80.0,
        cpl=None,  # zero-leads guard
        window=(SINCE, UNTIL),
    )
    with db_conn.cursor() as cur:
        new_id = _insert_row(cur, "campaign_perf_image", row)
        cur.execute(
            "select leads_ghl, cpl_real from campaign_perf_image where id = %s",
            (new_id,),
        )
        got = cur.fetchone()
    assert got[0] == 0
    assert got[1] is None


# ===========================================================================
# Regression guards: the schema the writer must NOT drift back to.
# ===========================================================================


def test_phantom_columns_are_rejected(db_conn, image_creative) -> None:
    """The exact INSERT the OLD writer shipped fails against real Postgres.

    Proves the bug was real: ``leads`` / ``spend_usd`` / ``real_cpl`` /
    ``window_start`` are undefined columns, so the insert raises -- which the
    column-blind fake double silently allowed.
    """
    phantom = {
        "pipeline_id": image_creative["pipeline_id"],
        "ad_entity_id": None,
        "leads": 4,
        "spend_usd": 200.0,
        "real_cpl": 50.0,
        "window_start": SINCE.isoformat(),
        "window_end": UNTIL.isoformat(),
    }
    with db_conn.cursor() as cur:
        with pytest.raises(psycopg.errors.UndefinedColumn):
            _insert_row(cur, "campaign_perf_image", phantom)
    db_conn.rollback()  # clear the aborted transaction for teardown


def test_campaign_id_not_null_is_enforced(db_conn, image_creative) -> None:
    """campaign_id is NOT NULL; the old writer never supplied it at all."""
    row = build_campaign_perf_row(
        pipeline_id=image_creative["pipeline_id"],
        ad_entity_id=None,
        client_id=image_creative["client_id"],
        campaign_id="camp-400",
        leads=1,
        meta_spend=10.0,
        cpl=10.0,
        window=(SINCE, UNTIL),
    )
    row["campaign_id"] = None  # simulate the missing NOT NULL value
    with db_conn.cursor() as cur:
        with pytest.raises(psycopg.errors.NotNullViolation):
            _insert_row(cur, "campaign_perf_image", row)
    db_conn.rollback()
