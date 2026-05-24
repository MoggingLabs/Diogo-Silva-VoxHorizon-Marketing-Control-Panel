"""Atomic video creative + iteration + event inserts (per pipeline stage).

The video pipeline is multi-stage:

  draft -> script_ready -> voiceover_ready -> broll_ready
        -> composed -> captioned -> approved

Each stage produces a new artifact (script, voiceover, b-roll picks, composed
MP4, captioned MP4) and must update the existing ``video_creatives`` row
in place. The first stage creates the row; subsequent stages patch new file
paths and bump the status.

Mirrors :mod:`worker.src.services.atomic_inserts` (image side). The
supabase-py client is not transactional, so each call performs sequential
round-trips:

1. ``video_creatives`` — insert (first stage) or update (subsequent stages).
2. ``video_iterations`` — append one row per stage call.
3. ``events`` — lightweight audit trail.

Failure modes are tolerable for v1: a crash between steps leaves the row
in a recoverable state (operator can rerun the stage). Stronger guarantees
would require a Postgres RPC; we accept the risk for now.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from ..supabase_client import get_supabase_admin


# Public type aliases mirror the database enums (see types.gen.ts /
# migration 0001). Keep these in lock-step.
VideoStage = Literal[
    "script",
    "voiceover",
    "broll_search",
    "broll_pick",
    "composed",
    "captioned",
]
VideoIterationKind = Literal[
    "generate_script",
    "regenerate_voiceover",
    "search_broll",
    "swap_broll",
    "rerender",
    "recaption",
    "comment",
    "user_edit",
]
Author = Literal["user", "ekko"]
VideoCreativeStatus = Literal[
    "draft",
    "script_ready",
    "voiceover_ready",
    "broll_ready",
    "composed",
    "captioned",
    "approved",
    "rejected",
]


# A stage call maps cleanly onto a single resulting status. Keep this
# table close to the enum so future stage additions stay grep-able.
STAGE_STATUS: dict[VideoStage, VideoCreativeStatus] = {
    "script": "script_ready",
    "voiceover": "voiceover_ready",
    "broll_search": "broll_ready",
    "broll_pick": "broll_ready",
    "composed": "composed",
    "captioned": "captioned",
}

# The set of path fields the caller may supply via ``paths``. We never
# overwrite a path field that wasn't named in the dict — passing
# ``{"script_path": "..."}`` only touches that column.
PATH_FIELDS: tuple[str, ...] = (
    "script_path",
    # ``script_outline`` is the generated script JSON (jsonb column, 0040). Like
    # ``broll_clips`` it is a structured output rather than a path, but it rides
    # in the same ``paths`` dict so the script stage persists it on the creative
    # (the spoken surface the voiceover stage + compliance gate read back).
    "script_outline",
    "voiceover_path",
    "composed_path",
    "captioned_path",
    # ``broll_clips`` is a jsonb column, but it's a "path-like" output of
    # the broll_search / broll_pick stages so we accept it in the same
    # ``paths`` dict for ergonomic symmetry.
    "broll_clips",
)


@dataclass(frozen=True)
class VideoStageResult:
    """Identifiers returned by :func:`record_video_stage`.

    ``new_creative`` is ``True`` when the call inserted a new
    ``video_creatives`` row, ``False`` when it patched an existing row.
    """

    creative_id: str
    iteration_id: str
    event_id: str
    status: VideoCreativeStatus
    new_creative: bool


async def record_video_stage(
    *,
    brief_id: str,
    stage: VideoStage,
    paths: dict[str, Any],
    iteration_kind: VideoIterationKind,
    iteration_content: dict[str, Any] | None = None,
    author: Author = "ekko",
    parent_creative_id: str | None = None,
    creative_id: str | None = None,
) -> VideoStageResult:
    """Atomically record one stage of a video creative pipeline.

    Behaviour:
      * If ``creative_id`` is ``None`` — insert a new ``video_creatives``
        row with ``status=STAGE_STATUS[stage]`` and the path fields named
        in ``paths``.
      * If ``creative_id`` is set — update that row, replacing the named
        path fields and bumping ``status`` to ``STAGE_STATUS[stage]``.
      * Always append a ``video_iterations`` row with ``creative_id``
        pointing at the (new or existing) creative.
      * Always append an ``events`` row tagged
        ``kind = "video_<iteration_kind>"`` for the audit trail.

    Args:
      brief_id: The owning ``video_briefs.id``.
      stage: Which pipeline stage just produced output.
      paths: Subset of ``PATH_FIELDS`` to write on the creative row.
        Unrecognised keys are dropped silently — supabase rejects unknown
        columns and we'd rather fail at the call site than the network.
      iteration_kind: The ``video_iteration_kind`` to record in the
        iteration row and embed in the event ``kind``.
      iteration_content: Free-form jsonb payload for the iteration; defaults
        to ``{"paths": paths}`` so the iteration always references *something*
        about what changed.
      author: Who authored this stage. Defaults to ``ekko`` (the agent).
      parent_creative_id: Optional pointer for branching/regeneration.
      creative_id: If set, patch this row instead of inserting.

    Returns:
      :class:`VideoStageResult` with the three row ids and the final status.
    """
    sb = get_supabase_admin()

    # 1. video_creatives -----------------------------------------------------
    status = STAGE_STATUS[stage]
    creative_payload: dict[str, Any] = {"status": status}
    for key in PATH_FIELDS:
        if key in paths:
            creative_payload[key] = paths[key]

    new_creative = creative_id is None
    if new_creative:
        creative_payload["brief_id"] = brief_id
        creative_row = (
            sb.table("video_creatives").insert(creative_payload).execute().data[0]
        )
    else:
        creative_row = (
            sb.table("video_creatives")
            .update(creative_payload)
            .eq("id", creative_id)
            .execute()
            .data[0]
        )
    resolved_creative_id: str = creative_row["id"]

    # 2. video_iterations ----------------------------------------------------
    iteration_row = (
        sb.table("video_iterations")
        .insert(
            {
                "creative_id": resolved_creative_id,
                "parent_creative_id": parent_creative_id,
                "author": author,
                "kind": iteration_kind,
                "content": iteration_content
                if iteration_content is not None
                else {"paths": paths},
            }
        )
        .execute()
        .data[0]
    )
    iteration_id: str = iteration_row["id"]

    # 3. events --------------------------------------------------------------
    event_row = (
        sb.table("events")
        .insert(
            {
                "kind": f"video_{iteration_kind}",
                "ref_table": "video_creatives",
                "ref_id": resolved_creative_id,
                "payload": {
                    "brief_id": brief_id,
                    "stage": stage,
                    "status": status,
                },
            }
        )
        .execute()
        .data[0]
    )
    event_id: str = event_row["id"]

    return VideoStageResult(
        creative_id=resolved_creative_id,
        iteration_id=iteration_id,
        event_id=event_id,
        status=status,
        new_creative=new_creative,
    )
