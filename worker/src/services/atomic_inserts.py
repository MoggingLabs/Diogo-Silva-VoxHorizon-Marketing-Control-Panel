"""Atomic creative + iteration inserts.

For each image-generation event we want three rows written together:

1. ``creatives`` — one row per generated PNG.
2. ``creative_iterations`` — one row capturing the prompt + model params
   used to produce that PNG.
3. ``events`` — a lightweight audit trail row referencing the creative.

The supabase-py client is not transactional, so this module performs three
sequential round-trips. The failure modes are tolerable for v1: a crash
after step 1 leaves a creative row without an iteration sibling, which can
be reconciled or re-emitted later. For stronger guarantees we'll move to a
Postgres function called via RPC.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from ..supabase_client import get_supabase_admin


Ratio = Literal["1x1", "9x16", "16x9"]
ImageKind = Literal["generate", "regenerate", "annotate", "comment", "user_edit"]
Author = Literal["user", "ekko"]


@dataclass(frozen=True)
class CreativeInsertResult:
    """Identifiers returned by `record_creative_stage`."""

    creative_id: str
    iteration_id: str
    event_id: str


async def record_creative_stage(
    *,
    brief_id: str,
    file_path_supabase: str,
    concept: str,
    offer_text: str | None,
    ratio: Ratio,
    version: str,
    prompt_used: dict[str, Any],
    iteration_kind: ImageKind = "generate",
    iteration_content: dict[str, Any] | None = None,
    author: Author = "ekko",
    parent_creative_id: str | None = None,
) -> CreativeInsertResult:
    """Insert creative + iteration + event rows for one generated PNG.

    ``file_path_supabase`` should be the storage path returned by
    :func:`worker.src.services.storage.upload_creative` (i.e. relative to
    the ``creatives`` bucket).

    ``iteration_content`` defaults to ``{"prompt": prompt_used}`` so the
    iteration always captures *something* about how the image was made,
    even if the caller doesn't pass extra context.

    The function is ``async`` for forward-compat and FastAPI ergonomics;
    the supabase-py calls themselves are synchronous.
    """
    sb = get_supabase_admin()

    # 1. creatives
    creative_row = (
        sb.table("creatives")
        .insert(
            {
                "brief_id": brief_id,
                "type": "image",
                "concept": concept,
                "offer_text": offer_text,
                "ratio": ratio,
                "version": version,
                "file_path_supabase": file_path_supabase,
                "prompt_used": prompt_used,
                "status": "draft",
            }
        )
        .execute()
        .data[0]
    )
    creative_id: str = creative_row["id"]

    # 2. creative_iterations
    iteration_row = (
        sb.table("creative_iterations")
        .insert(
            {
                "creative_id": creative_id,
                "parent_creative_id": parent_creative_id,
                "author": author,
                "kind": iteration_kind,
                "content": iteration_content
                if iteration_content is not None
                else {"prompt": prompt_used},
                "image_path_supabase": file_path_supabase,
            }
        )
        .execute()
        .data[0]
    )
    iteration_id: str = iteration_row["id"]

    # 3. events
    event_row = (
        sb.table("events")
        .insert(
            {
                "kind": f"creative_{iteration_kind}",
                "ref_table": "creatives",
                "ref_id": creative_id,
                "payload": {
                    "brief_id": brief_id,
                    "version": version,
                    "ratio": ratio,
                },
            }
        )
        .execute()
        .data[0]
    )
    event_id: str = event_row["id"]

    return CreativeInsertResult(
        creative_id=creative_id,
        iteration_id=iteration_id,
        event_id=event_id,
    )
