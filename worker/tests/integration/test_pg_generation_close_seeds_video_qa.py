"""B1: the generation-close trigger seeds the creative_qa gate for VIDEO.

`pipeline_events_auto_advance_done()` advances a pipeline from `generation` to
`creative_qa` and seeds one pending `creative_stage_state` gate row per FINAL
creative. Before migration 0046 the seed joined only `creatives` (image), so a
VIDEO / BOTH pipeline reached `creative_qa` with zero video gate rows and then
stalled forever (`pipeline_rollup_cleared()` needs >= 1 in-scope row to clear).

0046 added a parallel seed from `video_creatives` (the captioned render, keyed on
`video_brief_id`). These tests drive the REAL trigger against a real Postgres:
seed a pipeline in `generation`, emit a generation closure (queued + done
events), and assert the trigger advanced to `creative_qa` AND seeded the right
gate rows -- for video-only, both, and (regression) image-only pipelines.

The FK-blind unit double cannot exercise this: the trigger, the FK to the
neutral `creative` base, and the seed join all only fire against live Postgres.
"""

from __future__ import annotations

import pytest


pytestmark = pytest.mark.integration


def _seed_client(cur) -> str:
    cur.execute(
        """
        insert into clients (id, slug, name, service_type)
        values (gen_random_uuid(),
                'acme-roofing-' || substr(md5(random()::text), 1, 8),
                'Acme Roofing', 'roofing')
        returning id
        """
    )
    return str(cur.fetchone()[0])


def _seed_image_brief(cur, client_id: str) -> str:
    cur.execute(
        """
        insert into briefs (brief_id_human, client_id, status, payload)
        values ('acme-' || substr(md5(random()::text), 1, 12), %s, 'approved',
                '{"service": "roofing", "budget": 1000}'::jsonb)
        returning id
        """,
        (client_id,),
    )
    return str(cur.fetchone()[0])


def _seed_video_brief(cur, client_id: str) -> str:
    cur.execute(
        """
        insert into video_briefs
          (brief_id_human, client_id, status, target_duration_s, voice_id)
        values ('vid-acme-' || substr(md5(random()::text), 1, 12), %s,
                'approved', 30, 'voice-1')
        returning id
        """,
        (client_id,),
    )
    return str(cur.fetchone()[0])


def _seed_pipeline_in_generation(
    cur, client_id: str, *, image_brief_id: str | None, video_brief_id: str | None
) -> str:
    """A pipeline sitting in `generation` (where the close trigger acts).

    Silent-failure PR-4: ``pipelines.status`` was dropped (migration 0051);
    the canonical answer is the event-sourced reducer
    ``compute_pipeline_status(id)``. The accompanying ``_emit_generation_closure``
    helper writes the ``stage_advanced -> generation`` event the reducer reads,
    so we only insert the row here (no status column).
    """
    cur.execute(
        """
        insert into pipelines (format_choice, client_id, image_brief_id,
                               video_brief_id)
        values (%s, %s, %s, %s)
        returning id
        """,
        (
            "both" if image_brief_id and video_brief_id else ("image" if image_brief_id else "video"),
            client_id,
            image_brief_id,
            video_brief_id,
        ),
    )
    return str(cur.fetchone()[0])


def _emit_generation_closure(cur, pipeline_id: str, task_count: int = 2) -> None:
    """Emit the cutoff + a closed generation batch so the trigger fires.

    One `stage_advanced -> generation` cutoff, then `task_count` queued events
    and `task_count` done events. The trigger fires on each `task_done` insert;
    the last one satisfies the closure heuristic (v_done == v_expected, v_done>=1)
    and advances + seeds.
    """
    cur.execute(
        """
        insert into pipeline_events (pipeline_id, kind, stage, payload)
        values (%s, 'stage_advanced', 'generation', '{"from": "review"}'::jsonb)
        """,
        (pipeline_id,),
    )
    for _ in range(task_count):
        cur.execute(
            """
            insert into pipeline_events (pipeline_id, kind, stage, payload)
            values (%s, 'task_queued', 'generation', '{}'::jsonb)
            """,
            (pipeline_id,),
        )
    for _ in range(task_count):
        cur.execute(
            """
            insert into pipeline_events (pipeline_id, kind, stage, payload)
            values (%s, 'task_done', 'generation', '{}'::jsonb)
            """,
            (pipeline_id,),
        )


def _qa_creative_ids(cur, pipeline_id: str) -> set[str]:
    cur.execute(
        """
        select creative_id from creative_stage_state
         where pipeline_id = %s and stage = 'creative_qa'
        """,
        (pipeline_id,),
    )
    return {str(r[0]) for r in cur.fetchall()}


def _status(cur, pipeline_id: str) -> str:
    """Read the derived status via the reducer RPC.

    Silent-failure PR-4: ``pipelines.status`` was dropped (migration 0051);
    ``compute_pipeline_status(id)`` is the canonical answer.
    """
    cur.execute("select compute_pipeline_status(%s)", (pipeline_id,))
    return str(cur.fetchone()[0])


def test_video_only_generation_close_seeds_video_qa(db_conn) -> None:
    """A video-only pipeline advances to creative_qa AND seeds the video gate."""
    with db_conn.cursor() as cur:
        client_id = _seed_client(cur)
        vbrief = _seed_video_brief(cur, client_id)
        pid = _seed_pipeline_in_generation(
            cur, client_id, image_brief_id=None, video_brief_id=vbrief
        )
        cur.execute(
            "insert into video_creatives (brief_id, version, status) "
            "values (%s, 1, 'captioned') returning id",
            (vbrief,),
        )
        vc_id = str(cur.fetchone()[0])

        _emit_generation_closure(cur, pid)

        assert _status(cur, pid) == "creative_qa"
        seeded = _qa_creative_ids(cur, pid)
        assert seeded == {vc_id}, "the captioned video creative must own a creative_qa gate row"


def test_both_generation_close_seeds_image_and_video_qa(db_conn) -> None:
    """A both pipeline seeds a creative_qa gate row for each track's final."""
    with db_conn.cursor() as cur:
        client_id = _seed_client(cur)
        ibrief = _seed_image_brief(cur, client_id)
        vbrief = _seed_video_brief(cur, client_id)
        pid = _seed_pipeline_in_generation(
            cur, client_id, image_brief_id=ibrief, video_brief_id=vbrief
        )
        cur.execute(
            "insert into creatives (brief_id, type, concept, ratio, version, status) "
            "values (%s, 'image', 'fresh-roof', '1x1', 'v1.0', 'draft') returning id",
            (ibrief,),
        )
        ic_id = str(cur.fetchone()[0])
        cur.execute(
            "insert into video_creatives (brief_id, version, status) "
            "values (%s, 1, 'captioned') returning id",
            (vbrief,),
        )
        vc_id = str(cur.fetchone()[0])

        _emit_generation_closure(cur, pid)

        assert _status(cur, pid) == "creative_qa"
        assert _qa_creative_ids(cur, pid) == {ic_id, vc_id}


def test_image_only_generation_close_unchanged(db_conn) -> None:
    """Regression: the image seed is unchanged (image-only seeds only image)."""
    with db_conn.cursor() as cur:
        client_id = _seed_client(cur)
        ibrief = _seed_image_brief(cur, client_id)
        pid = _seed_pipeline_in_generation(
            cur, client_id, image_brief_id=ibrief, video_brief_id=None
        )
        cur.execute(
            "insert into creatives (brief_id, type, concept, ratio, version, status) "
            "values (%s, 'image', 'fresh-roof', '1x1', 'v1.0', 'draft') returning id",
            (ibrief,),
        )
        ic_id = str(cur.fetchone()[0])

        _emit_generation_closure(cur, pid)

        assert _status(cur, pid) == "creative_qa"
        assert _qa_creative_ids(cur, pid) == {ic_id}


def test_video_non_captioned_is_not_seeded(db_conn) -> None:
    """Only the finished (captioned) render enters QA; a composed-only creative
    is not seeded (it is not a shippable final)."""
    with db_conn.cursor() as cur:
        client_id = _seed_client(cur)
        vbrief = _seed_video_brief(cur, client_id)
        pid = _seed_pipeline_in_generation(
            cur, client_id, image_brief_id=None, video_brief_id=vbrief
        )
        cur.execute(
            "insert into video_creatives (brief_id, version, status) "
            "values (%s, 1, 'composed') returning id",
            (vbrief,),
        )
        _emit_generation_closure(cur, pid)
        # Advanced (the batch closed) but the non-captioned creative is excluded.
        assert _qa_creative_ids(cur, pid) == set()


# ---------------------------------------------------------------------------
# FIX-A: the auto-advance trigger dispatches the creative_qa PRODUCER on entry.
# ---------------------------------------------------------------------------
#
# Before FIX-A the trigger seeded the gate rows but enqueued NO work_item, so
# the post-generation per-creative stages had no producer and every pipeline
# deadlocked at creative_qa. These prove the trigger now enqueues the right
# dispatch kind branching on config_draft.operator_driven -- the migration-apply
# CI job is the SQL validator; this is the behaviour assertion.


def _work_item_kinds(cur, pipeline_id: str) -> list[str]:
    cur.execute(
        "select kind::text from work_item where pipeline_id = %s order by created_at",
        (pipeline_id,),
    )
    return [str(r[0]) for r in cur.fetchall()]


def test_deterministic_close_enqueues_worker_qa(db_conn) -> None:
    """A non-operator pipeline gets a worker_qa work_item on creative_qa entry."""
    with db_conn.cursor() as cur:
        client_id = _seed_client(cur)
        ibrief = _seed_image_brief(cur, client_id)
        pid = _seed_pipeline_in_generation(
            cur, client_id, image_brief_id=ibrief, video_brief_id=None
        )
        cur.execute(
            "insert into creatives (brief_id, type, concept, ratio, version, status) "
            "values (%s, 'image', 'fresh-roof', '1x1', 'v1.0', 'draft') returning id",
            (ibrief,),
        )
        _emit_generation_closure(cur, pid)
        assert _status(cur, pid) == "creative_qa"
        kinds = _work_item_kinds(cur, pid)
        assert "worker_qa" in kinds
        assert "operator_dispatch" not in kinds
        # Idempotent: the work_item carries the deterministic key.
        cur.execute(
            "select idempotency_key from work_item "
            "where pipeline_id = %s and kind = 'worker_qa'",
            (pid,),
        )
        assert cur.fetchone()[0] == f"wi:{pid}:creative_qa"


def test_operator_close_enqueues_operator_dispatch(db_conn) -> None:
    """An operator-driven pipeline gets an operator_dispatch on creative_qa entry."""
    with db_conn.cursor() as cur:
        client_id = _seed_client(cur)
        ibrief = _seed_image_brief(cur, client_id)
        cur.execute(
            """
            insert into pipelines (format_choice, client_id, image_brief_id, config_draft)
            values ('image', %s, %s, '{"operator_driven": true}'::jsonb)
            returning id
            """,
            (client_id, ibrief),
        )
        pid = str(cur.fetchone()[0])
        cur.execute(
            "insert into creatives (brief_id, type, concept, ratio, version, status) "
            "values (%s, 'image', 'fresh-roof', '1x1', 'v1.0', 'draft') returning id",
            (ibrief,),
        )
        _emit_generation_closure(cur, pid)
        assert _status(cur, pid) == "creative_qa"
        kinds = _work_item_kinds(cur, pid)
        assert "operator_dispatch" in kinds
        assert "worker_qa" not in kinds
        # The operator dispatch carries the instruction + the auto idempotency key.
        cur.execute(
            "select idempotency_key, payload->>'instruction', payload->>'stage' "
            "from work_item where pipeline_id = %s and kind = 'operator_dispatch'",
            (pid,),
        )
        key, instruction, stage = cur.fetchone()
        assert key == f"op-disp:{pid}:creative_qa:auto"
        assert stage == "creative_qa"
        assert pid in str(instruction)
        assert "QA pass" in str(instruction)
