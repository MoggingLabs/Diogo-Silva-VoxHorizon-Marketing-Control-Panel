"""Video pipeline route stub.

The full video pipeline (script → voiceover → b-roll → compose → caption)
was deleted in Wave 19 (HI-8) along with its entire service tree
(``elevenlabs``, ``submagic``, ``hyperframes``, ``broll_*``,
``atomic_inserts_video`` route handlers, …). The image-generation restore
(``feat/restore-image-generation``) deliberately does NOT bring the video
path back to working order — only the IMAGE pipeline is in scope.

This module exists so the *image* pipeline's generation orchestrator
(:func:`worker.src.services... routes.pipeline._produce_generation_video_pick`)
can still resolve its lazy ``from ..routes import video`` import without
crashing the worker at startup, and so the pipeline test-suite's video
branches can monkey-patch these handler names. The substage handlers raise
:class:`NotImplementedError` if ever actually invoked — in production the
video picks path is dormant; in tests the handlers are monkey-patched.

Do NOT wire this router into :mod:`worker.src.main`: it carries no
endpoints. If/when the video pipeline is restored, replace this stub with
the real ``video.py`` from ``381eb4a^`` plus its service dependencies.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field


router = APIRouter()


_NOT_RESTORED = (
    "The video pipeline was not restored by feat/restore-image-generation — "
    "only the image-generation path is in scope. Restore worker/src/routes/"
    "video.py and its service tree (elevenlabs/submagic/hyperframes/broll_*) "
    "from git ref 381eb4a^ to re-enable video generation."
)


# ---------------------------------------------------------------------------
# Request models — field shapes mirror the deleted video.py so the pipeline
# generation orchestrator's `video_route.<Model>Request(...)` construction
# stays valid. (Restored verbatim from 381eb4a^:worker/src/routes/video.py.)
# ---------------------------------------------------------------------------


class ScriptRequest(BaseModel):
    """POST body for ``/work/video/script``."""

    brief_id: str = Field(..., min_length=1)


class VoiceoverRequest(BaseModel):
    """POST body for ``/work/video/voiceover``."""

    creative_id: str = Field(..., min_length=1)
    speed: float = 1.0


class BrollSearchRequest(BaseModel):
    """POST body for ``/work/video/broll-search``."""

    creative_id: str = Field(..., min_length=1)
    per_segment: int = 5


class BrollSelectRequest(BaseModel):
    """POST body for ``/work/video/broll-select``."""

    creative_id: str = Field(..., min_length=1)
    mode: Literal["auto", "review_each", "review_low_confidence"] | None = None
    allow_review_low_confidence: bool = False


class ComposeRequest(BaseModel):
    """POST body for ``/work/video/compose``."""

    creative_id: str = Field(..., min_length=1)


class CaptionRequest(BaseModel):
    """POST body for ``/work/video/caption``."""

    creative_id: str = Field(..., min_length=1)


# ---------------------------------------------------------------------------
# Substage handlers — dormant. The image pipeline's video-pick orchestrator
# dispatches to these by name; they're monkey-patched in tests and raise in
# production because the video service tree is not present.
# ---------------------------------------------------------------------------


async def generate_script(req: ScriptRequest) -> dict[str, object]:
    raise NotImplementedError(_NOT_RESTORED)


async def synthesize_voiceover(req: VoiceoverRequest) -> dict[str, object]:
    raise NotImplementedError(_NOT_RESTORED)


async def search_broll(req: BrollSearchRequest) -> dict[str, object]:
    raise NotImplementedError(_NOT_RESTORED)


async def select_broll(req: BrollSelectRequest) -> dict[str, object]:
    raise NotImplementedError(_NOT_RESTORED)


async def compose_video(req: ComposeRequest) -> dict[str, object]:
    raise NotImplementedError(_NOT_RESTORED)


async def caption_video(req: CaptionRequest) -> dict[str, object]:
    raise NotImplementedError(_NOT_RESTORED)


__all__ = [
    "router",
    "ScriptRequest",
    "VoiceoverRequest",
    "BrollSearchRequest",
    "BrollSelectRequest",
    "ComposeRequest",
    "CaptionRequest",
    "generate_script",
    "synthesize_voiceover",
    "search_broll",
    "select_broll",
    "compose_video",
    "caption_video",
]
