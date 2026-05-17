"""Video creative pipeline routes (V2-1/3/4/5/6/7).

Each stage of the video creative flow is a separate POST endpoint on this
router:

    /work/video/script          generate hook + per-segment script JSON
    /work/video/voiceover       ElevenLabs TTS per segment + ffmpeg concat
    /work/video/broll-search    yt-dlp scrape ~5 candidates per segment
    /work/video/broll-select    apply broll_selection_mode (V2-5)
    /work/video/compose         Hyperframes scenes.html → MP4 render
    /work/video/caption         Submagic captioning

All stages share two infrastructure pieces:

1. **Sequential per-brief queue (V2-16).** Every route wraps its critical
   section in ``async with get_queue().acquire(video_brief_id)``. The
   ``BriefQueue`` singleton from M2-12 is keyed by an arbitrary string —
   video brief UUIDs live in a different table than image briefs but the
   queue doesn't care, so we get free per-brief serialization without
   extending the queue infrastructure.

2. **Atomic stage persistence.** Every stage ends with one call to
   :func:`record_video_stage` which writes ``video_creatives`` (insert or
   update), ``video_iterations``, and ``events`` in order. Stage status
   bumps are encoded in :data:`atomic_inserts_video.STAGE_STATUS` so
   adding a new stage is one enum + one table edit.

This module is intentionally a thick "wire it all together" layer — the
heavy logic lives under :mod:`worker.src.services` so each service is
unit-testable in isolation. The route layer here is mostly fetch +
validate + dispatch + record.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import uuid
from pathlib import Path
from typing import Any, Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import verify_secret
from ..services.atomic_inserts_video import record_video_stage
from ..services.broll_search import scrape_yt_shorts
from ..services.broll_selection import (
    Candidate as SelectionCandidate,
    Segment as SelectionSegment,
    SelectionMode,
    SelectionResult,
    VALID_MODES,
    apply_selection_mode,
)
from ..services.broll_store import StoredClip, get_broll_store
from ..services.claude_runner import ClaudeRunner
from ..services.elevenlabs import (
    ElevenLabsClient,
    ffmpeg_concat_mp3,
    synthesize_segments,
)
from ..services.hyperframes import author_and_render, scene_from_script
from ..services.queue import get_queue
from ..services.storage import BUCKET
from ..services.submagic import SubmagicClient
from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


router = APIRouter()


# Path to the bundled video-voiceover-broll skill (V2-2 shipped this).
VIDEO_SKILL_PATH = (
    Path(__file__).resolve().parent.parent.parent / "skills" / "video-voiceover-broll"
)


# ---------------------------------------------------------------------------
# Helpers shared across routes
# ---------------------------------------------------------------------------


def _supabase():
    return get_supabase_admin()


def _fetch_video_brief(brief_id: str) -> dict[str, Any]:
    """Pull the brief row + minimal client linkage. 404 if missing."""
    resp = (
        _supabase()
        .table("video_briefs")
        .select("*, clients(slug, name)")
        .eq("id", brief_id)
        .maybe_single()
        .execute()
    )
    row = resp.data
    if not row:
        raise HTTPException(status_code=404, detail=f"video brief not found: {brief_id}")
    return row


def _fetch_video_creative(creative_id: str) -> dict[str, Any]:
    """Pull the creative row + its parent brief. 404 if missing."""
    resp = (
        _supabase()
        .table("video_creatives")
        .select("*, video_briefs(*)")
        .eq("id", creative_id)
        .maybe_single()
        .execute()
    )
    row = resp.data
    if not row:
        raise HTTPException(
            status_code=404, detail=f"video creative not found: {creative_id}"
        )
    return row


def _brief_id_from_creative(creative: dict[str, Any]) -> str:
    """Get the brief_id off a creative row; raise 409 if absent."""
    bid = creative.get("brief_id")
    if not isinstance(bid, str) or not bid:
        raise HTTPException(
            status_code=409,
            detail=f"video creative {creative.get('id')!r} has no brief_id",
        )
    return bid


def _upload_to_storage(
    *,
    local_path: Path,
    storage_path: str,
    content_type: str,
    bucket: str = BUCKET,
) -> str:
    """Upload a local file to Supabase Storage and return the storage path.

    Mirrors :func:`worker.src.services.storage.upload_creative` but accepts
    a free-form content type so we can put MP3 / MP4 / JSON next to PNGs.
    """
    if not local_path.exists():
        raise FileNotFoundError(f"local_path does not exist: {local_path}")
    sb = _supabase()
    data = local_path.read_bytes()
    sb.storage.from_(bucket).upload(
        path=storage_path,
        file=data,
        file_options={"content-type": content_type, "x-upsert": "true"},
    )
    return storage_path


def _upload_bytes_to_storage(
    *,
    data: bytes,
    storage_path: str,
    content_type: str,
    bucket: str = BUCKET,
) -> str:
    """Upload raw bytes to Storage. Used by the caption route which has
    bytes in memory from Submagic."""
    sb = _supabase()
    sb.storage.from_(bucket).upload(
        path=storage_path,
        file=data,
        file_options={"content-type": content_type, "x-upsert": "true"},
    )
    return storage_path


def _sign_storage_url(storage_path: str, ttl_s: int = 3600, bucket: str = BUCKET) -> str:
    """Create a signed URL for a Storage object."""
    sb = _supabase()
    payload = sb.storage.from_(bucket).create_signed_url(storage_path, ttl_s)
    # supabase-py returns ``{"signedURL": "..."}``; normalize and prefer the
    # most common key. The supabase project URL is already baked into the
    # signed url so callers can pass it straight through to Submagic.
    if isinstance(payload, dict):
        for key in ("signedURL", "signedUrl", "signed_url"):
            if isinstance(payload.get(key), str):
                return payload[key]
    raise RuntimeError(f"unexpected signed-url response: {payload!r}")


# ---------------------------------------------------------------------------
# V2-1: /work/video/script
# ---------------------------------------------------------------------------


class ScriptRequest(BaseModel):
    """POST body for ``/work/video/script``."""

    brief_id: str = Field(..., min_length=1)


def _build_script_prompt(brief: dict[str, Any]) -> str:
    """Render the Claude prompt that feeds the video-voiceover-broll skill.

    Kept short and structural — the SKILL.md body contains all the
    detailed rules. We hand the agent the brief payload verbatim so it
    has every field the skill might want to read.
    """
    payload = brief.get("payload") or {}
    return (
        "You are running the `video-voiceover-broll` skill. "
        "Generate the production-ready script JSON object for the brief "
        "below. Return ONLY the JSON object specified by the skill output "
        "schema. No prose, no markdown fence, no follow-up commentary.\n\n"
        f"```json\n{json.dumps({'brief': brief, 'payload': payload}, default=str)}\n```"
    )


def _parse_script_output(raw: str) -> dict[str, Any]:
    """Validate the agent's output against the skill schema.

    The skill mandates exactly these top-level keys and shapes; we don't
    re-litigate the per-field rules here (the skill enforces them) but we
    do enforce the structural envelope so a malformed response gets a
    clear 502 rather than crashing downstream stages.
    """
    text = raw.strip()
    # Tolerate a markdown fence the skill explicitly forbids — agents
    # sometimes emit one anyway. Strip the leading / trailing ``` if so.
    if text.startswith("```"):
        # Remove the first line ("```" or "```json"), keep everything until the
        # closing fence on its own line.
        lines = text.splitlines()
        if lines:
            lines = lines[1:]
        while lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)

    try:
        payload = json.loads(text)
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=502,
            detail=f"script generator returned invalid JSON: {e.msg}",
        ) from e

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=502, detail="script generator output is not a JSON object"
        )

    required_top = {"hook", "segments", "outro", "total_duration_s"}
    missing = required_top - set(payload.keys())
    if missing:
        raise HTTPException(
            status_code=502,
            detail=f"script output missing required keys: {sorted(missing)}",
        )

    segments = payload["segments"]
    if not isinstance(segments, list) or not (1 <= len(segments) <= 4):
        raise HTTPException(
            status_code=502,
            detail="script output `segments` must be a list of 1-4 entries",
        )
    for i, seg in enumerate(segments):
        if not isinstance(seg, dict):
            raise HTTPException(
                status_code=502, detail=f"segment[{i}] is not an object"
            )
        for key in (
            "idx",
            "topic",
            "duration_s",
            "voiceover_text",
            "voiceover_direction",
            "broll_query",
            "broll_intent",
            "captions_emphasis",
        ):
            if key not in seg:
                raise HTTPException(
                    status_code=502,
                    detail=f"segment[{i}] missing required key: {key}",
                )
    # ``idx`` must be 0-contiguous.
    idxs = [int(s["idx"]) for s in segments]
    if idxs != list(range(len(idxs))):
        raise HTTPException(
            status_code=502, detail=f"segment idx values not 0-contiguous: {idxs!r}"
        )

    return payload


@router.post("/work/video/script", dependencies=[Depends(verify_secret)])
async def generate_script(req: ScriptRequest) -> dict[str, Any]:
    """Generate the ``script_outline`` JSON for a video brief.

    Spawns Claude Code with the ``video-voiceover-broll`` skill, captures
    its JSON output, validates it, persists the script artifact to
    Storage, and writes the first ``video_creatives`` row for this brief.

    NOTE: depends on Agent CG's :class:`ClaudeRunner` real implementation.
    Until that lands on main, this raises 501 via the stub.
    """
    brief = _fetch_video_brief(req.brief_id)

    async with get_queue().acquire(req.brief_id):
        prompt = _build_script_prompt(brief)
        try:
            raw = await ClaudeRunner().run_subprocess(prompt, cwd=str(VIDEO_SKILL_PATH))
        except NotImplementedError as e:
            # CG's runner hasn't merged. Surface as 501 so the operator
            # sees a clear "pipeline not ready" rather than a 500.
            log.warning("script_runner_not_ready", brief_id=req.brief_id)
            raise HTTPException(status_code=501, detail=str(e)) from e

        script_outline = _parse_script_output(raw)

        # Persist the script JSON as an artifact so the operator can read
        # it (and so a manual edit shows up as a new file revision).
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as fh:
            tmp_path = Path(fh.name)
            tmp_path.write_text(json.dumps(script_outline, indent=2))
        try:
            storage_path = f"{req.brief_id}/script-{uuid.uuid4().hex[:8]}.json"
            _upload_to_storage(
                local_path=tmp_path,
                storage_path=storage_path,
                content_type="application/json",
            )
        finally:
            try:
                tmp_path.unlink()
            except FileNotFoundError:
                pass

        result = await record_video_stage(
            brief_id=req.brief_id,
            stage="script",
            paths={"script_path": storage_path},
            iteration_kind="generate_script",
            iteration_content={"prompt": prompt, "output": script_outline},
        )

    log.info(
        "video_script_done",
        brief_id=req.brief_id,
        creative_id=result.creative_id,
        segments=len(script_outline["segments"]),
    )
    return {
        "ok": True,
        "creative_id": result.creative_id,
        "script_path": storage_path,
        "script_outline": script_outline,
    }


# ---------------------------------------------------------------------------
# V2-3: /work/video/voiceover
# ---------------------------------------------------------------------------


class VoiceoverRequest(BaseModel):
    """POST body for ``/work/video/voiceover``."""

    creative_id: str = Field(..., min_length=1)
    speed: float = 1.0


@router.post("/work/video/voiceover", dependencies=[Depends(verify_secret)])
async def synthesize_voiceover(req: VoiceoverRequest) -> dict[str, Any]:
    """Generate per-segment voiceover MP3s and concatenate into one track."""
    creative = _fetch_video_creative(req.creative_id)
    brief_id = _brief_id_from_creative(creative)
    brief = creative.get("video_briefs") or {}

    script = creative.get("script_outline")
    if not script:
        # The script lives on the brief or on a previously-stored JSON;
        # fall back to the brief's ``payload.script_outline`` if needed.
        payload = brief.get("payload") if isinstance(brief, dict) else None
        script = (payload or {}).get("script_outline")
    if not isinstance(script, dict) or not script.get("segments"):
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no script_outline yet",
        )

    voice_id = (
        creative.get("voice_id")
        or (brief.get("voice_id") if isinstance(brief, dict) else None)
    )
    if not isinstance(voice_id, str) or not voice_id:
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no voice_id (set it on the brief)",
        )

    async with get_queue().acquire(brief_id):
        async with ElevenLabsClient() as client:
            voice_segments = await synthesize_segments(
                client=client,
                segments=script["segments"],
                voice_id=voice_id,
                speed=req.speed,
            )

        # Concatenate per-segment MP3s into one track.
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as fh:
            concat_path = Path(fh.name)
        try:
            await ffmpeg_concat_mp3(
                [vs.local_path for vs in voice_segments],
                concat_path,
            )

            storage_path = (
                f"{brief_id}/voiceover-{req.creative_id}-{uuid.uuid4().hex[:8]}.mp3"
            )
            _upload_to_storage(
                local_path=concat_path,
                storage_path=storage_path,
                content_type="audio/mpeg",
            )
        finally:
            try:
                concat_path.unlink()
            except FileNotFoundError:
                pass

        existed = bool(creative.get("voiceover_path"))
        result = await record_video_stage(
            brief_id=brief_id,
            stage="voiceover",
            paths={"voiceover_path": storage_path},
            iteration_kind="regenerate_voiceover" if existed else "generate_voiceover",
            iteration_content={
                "voice_id": voice_id,
                "speed": req.speed,
                "segments": [
                    {"idx": vs.idx, "bytes": vs.bytes_size}
                    for vs in voice_segments
                ],
            },
            creative_id=req.creative_id,
        )

    log.info(
        "video_voiceover_done",
        brief_id=brief_id,
        creative_id=req.creative_id,
        segments=len(voice_segments),
    )
    return {
        "ok": True,
        "creative_id": result.creative_id,
        "voiceover_path": storage_path,
        "segments": [
            {"idx": vs.idx, "bytes": vs.bytes_size} for vs in voice_segments
        ],
    }


# ---------------------------------------------------------------------------
# V2-4: /work/video/broll-search
# ---------------------------------------------------------------------------


class BrollSearchRequest(BaseModel):
    """POST body for ``/work/video/broll-search``."""

    creative_id: str = Field(..., min_length=1)
    per_segment: int = 5


@router.post("/work/video/broll-search", dependencies=[Depends(verify_secret)])
async def search_broll(req: BrollSearchRequest) -> dict[str, Any]:
    """Scrape ~N b-roll candidates per segment and store via LocalBrollStore."""
    creative = _fetch_video_creative(req.creative_id)
    brief_id = _brief_id_from_creative(creative)
    script = creative.get("script_outline")
    if not isinstance(script, dict) or not script.get("segments"):
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no script_outline; "
            f"can't determine broll queries",
        )

    store = get_broll_store()

    async with get_queue().acquire(brief_id):
        candidates_by_segment: dict[str, list[dict[str, Any]]] = {}

        for seg in script["segments"]:
            idx = int(seg["idx"])
            query = (seg.get("broll_query") or "").strip()
            theme = (seg.get("broll_theme") or seg.get("topic") or "").strip()
            if not query:
                raise HTTPException(
                    status_code=409,
                    detail=f"segment[{idx}] has empty broll_query",
                )
            try:
                scraped = await scrape_yt_shorts(query, count=req.per_segment)
            except RuntimeError as e:
                # yt-dlp missing or non-zero — surface as 503 so the
                # operator UI can show "scrape unavailable".
                log.warning(
                    "broll_search_unavailable",
                    creative_id=req.creative_id,
                    segment_idx=idx,
                    error=str(e),
                )
                raise HTTPException(status_code=503, detail=str(e)) from e

            stored_clips: list[dict[str, Any]] = []
            for cand in scraped:
                stored = await store.put(
                    cand.source_url,
                    cand.local_path,
                    theme=theme or None,
                    duration_s=cand.duration_s,
                    dimensions=cand.dimensions,
                )
                stored_clips.append(stored.to_dict())
            candidates_by_segment[str(idx)] = stored_clips

        # Persist the per-segment shortlist on the creative row (jsonb).
        result = await record_video_stage(
            brief_id=brief_id,
            stage="broll_search",
            paths={"broll_clips": {"candidates": candidates_by_segment}},
            iteration_kind="search_broll",
            iteration_content={
                "candidates_by_segment": candidates_by_segment,
            },
            creative_id=req.creative_id,
        )

    log.info(
        "video_broll_search_done",
        brief_id=brief_id,
        creative_id=req.creative_id,
        segments=len(candidates_by_segment),
        total_candidates=sum(len(v) for v in candidates_by_segment.values()),
    )
    return {
        "ok": True,
        "creative_id": result.creative_id,
        "candidates": candidates_by_segment,
    }


# ---------------------------------------------------------------------------
# V2-5: /work/video/broll-select
# ---------------------------------------------------------------------------


class BrollSelectRequest(BaseModel):
    """POST body for ``/work/video/broll-select``."""

    creative_id: str = Field(..., min_length=1)
    mode: Literal["auto", "review_each", "review_low_confidence"] | None = None
    allow_review_low_confidence: bool = False


def _coerce_candidates_for_selection(
    raw_candidates: dict[str, list[dict[str, Any]]],
) -> dict[int, list[SelectionCandidate]]:
    """Turn the persisted jsonb shortlist into selector inputs."""
    out: dict[int, list[SelectionCandidate]] = {}
    for key, clips in raw_candidates.items():
        try:
            idx = int(key)
        except (ValueError, TypeError) as e:
            raise HTTPException(
                status_code=409,
                detail=f"non-int candidate segment key: {key!r}",
            ) from e
        items: list[SelectionCandidate] = []
        for clip in clips:
            items.append(
                SelectionCandidate(
                    clip_id=str(clip.get("clip_id") or ""),
                    source_url=str(clip.get("source_url") or ""),
                    theme=clip.get("theme"),
                    title=clip.get("title"),
                    description=clip.get("description"),
                    tags=tuple(clip.get("tags") or ()),
                    duration_s=clip.get("duration_s"),
                    dimensions=clip.get("dimensions"),
                )
            )
        out[idx] = items
    return out


def _segments_from_script(script: dict[str, Any]) -> dict[int, SelectionSegment]:
    out: dict[int, SelectionSegment] = {}
    for seg in script.get("segments") or []:
        idx = int(seg["idx"])
        out[idx] = SelectionSegment(
            idx=idx,
            theme=str(seg.get("broll_theme") or seg.get("topic") or ""),
            query=str(seg.get("broll_query") or ""),
            intent=str(seg.get("broll_intent") or ""),
        )
    return out


@router.post("/work/video/broll-select", dependencies=[Depends(verify_secret)])
async def select_broll(req: BrollSelectRequest) -> dict[str, Any]:
    """Apply the brief's ``broll_selection_mode`` to the shortlist.

    Returns either a ``resolved`` mapping (``auto``, or high-confidence
    ``review_low_confidence`` picks) or a ``needs_review`` payload for the
    operator UI (``review_each``, plus the low-confidence escalations).
    """
    creative = _fetch_video_creative(req.creative_id)
    brief_id = _brief_id_from_creative(creative)
    brief = creative.get("video_briefs") or {}
    script = creative.get("script_outline")
    if not isinstance(script, dict) or not script.get("segments"):
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no script_outline yet",
        )

    raw_clips = creative.get("broll_clips") or {}
    candidates = raw_clips.get("candidates") if isinstance(raw_clips, dict) else None
    if not isinstance(candidates, dict) or not candidates:
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no broll candidates yet "
            f"(run /work/video/broll-search first)",
        )

    # Mode resolution: explicit body wins, else brief field, else default.
    mode: SelectionMode = (
        req.mode
        or (brief.get("broll_selection_mode") if isinstance(brief, dict) else None)
        or "auto"
    )
    if mode not in VALID_MODES:
        raise HTTPException(
            status_code=400, detail=f"unknown broll_selection_mode: {mode!r}"
        )

    sel_candidates = _coerce_candidates_for_selection(candidates)
    sel_segments = _segments_from_script(script)

    try:
        selection: SelectionResult = apply_selection_mode(
            mode=mode,
            candidates=sel_candidates,
            segments=sel_segments,
            allow_review_low_confidence=req.allow_review_low_confidence,
        )
    except NotImplementedError as e:
        # review_low_confidence behind a flag in v2.
        raise HTTPException(status_code=501, detail=str(e)) from e

    async with get_queue().acquire(brief_id):
        # Selection writes ``broll_clips.selected`` (and persists confidence)
        # so the compose stage can read it without re-running the scorer.
        selection_payload = {
            "candidates": candidates,
            "selected": {
                str(idx): {
                    "clip_id": sc.candidate.clip_id,
                    "source_url": sc.candidate.source_url,
                }
                for idx, sc in selection.resolved.items()
            },
            "needs_review": {
                str(idx): [sc.to_dict() for sc in shortlist]
                for idx, shortlist in selection.needs_review.items()
            },
            "confidence": {
                str(idx): round(c, 4) for idx, c in selection.confidence.items()
            },
            "mode": mode,
        }

        # If we resolved every segment we're now broll_ready (broll_pick
        # stage). If we still have things needing review we stay at the
        # broll_ready status but record the iteration as a search step.
        iteration_kind = (
            "swap_broll" if selection.resolved else "search_broll"
        )

        result = await record_video_stage(
            brief_id=brief_id,
            stage="broll_pick" if selection.resolved else "broll_search",
            paths={"broll_clips": selection_payload},
            iteration_kind=iteration_kind,
            iteration_content={"mode": mode, "selection": selection.to_dict()},
            creative_id=req.creative_id,
        )

    log.info(
        "video_broll_select_done",
        brief_id=brief_id,
        creative_id=req.creative_id,
        mode=mode,
        resolved=len(selection.resolved),
        needs_review=len(selection.needs_review),
    )
    return {
        "ok": True,
        "creative_id": result.creative_id,
        **selection.to_dict(),
    }


# ---------------------------------------------------------------------------
# V2-6: /work/video/compose
# ---------------------------------------------------------------------------


class ComposeRequest(BaseModel):
    """POST body for ``/work/video/compose``."""

    creative_id: str = Field(..., min_length=1)


@router.post("/work/video/compose", dependencies=[Depends(verify_secret)])
async def compose_video(req: ComposeRequest) -> dict[str, Any]:
    """Render the Hyperframes scene HTML and produce the composed MP4."""
    creative = _fetch_video_creative(req.creative_id)
    brief_id = _brief_id_from_creative(creative)
    brief = creative.get("video_briefs") or {}

    script = creative.get("script_outline")
    if not isinstance(script, dict) or not script.get("segments"):
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no script_outline yet",
        )

    voiceover_path = creative.get("voiceover_path")
    if not isinstance(voiceover_path, str) or not voiceover_path:
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no voiceover yet "
            f"(run /work/video/voiceover first)",
        )

    raw_clips = creative.get("broll_clips") or {}
    selected = raw_clips.get("selected") if isinstance(raw_clips, dict) else None
    if not isinstance(selected, dict) or not selected:
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no resolved broll clips yet "
            f"(run /work/video/broll-select first)",
        )

    # Resolve each selected clip into a signed URL the Hyperframes
    # Chromium can fetch.
    store = get_broll_store()
    selected_urls: dict[int, str] = {}
    for key, sel in selected.items():
        idx = int(key)
        clip_id = sel.get("clip_id") if isinstance(sel, dict) else None
        if not isinstance(clip_id, str):
            raise HTTPException(
                status_code=409,
                detail=f"selected clip for segment[{idx}] has no clip_id",
            )
        url = await store.get_signed_url(clip_id)
        selected_urls[idx] = url

    dimensions = (
        brief.get("dimensions") if isinstance(brief, dict) else None
    ) or "9x16"
    captions_style = (
        brief.get("captions_style") if isinstance(brief, dict) else None
    ) or "bold_yellow"

    # Signed voiceover URL — Hyperframes pulls audio over HTTP.
    voiceover_url = _sign_storage_url(voiceover_path)

    scene = scene_from_script(
        script_outline=script,
        selected_clips=selected_urls,
        voiceover_url=voiceover_url,
        dimensions=dimensions,
        captions_style=captions_style,
    )

    async with get_queue().acquire(brief_id):
        work_dir = Path(tempfile.mkdtemp(prefix="vox-compose-"))
        try:
            try:
                render = await author_and_render(scene=scene, work_dir=work_dir)
            except RuntimeError as e:
                # Hyperframes CLI missing or render exit non-zero.
                log.warning(
                    "compose_unavailable",
                    creative_id=req.creative_id,
                    error=str(e),
                )
                raise HTTPException(status_code=503, detail=str(e)) from e

            storage_path = (
                f"{brief_id}/composed-{req.creative_id}-{uuid.uuid4().hex[:8]}.mp4"
            )
            _upload_to_storage(
                local_path=render.output_mp4_path,
                storage_path=storage_path,
                content_type="video/mp4",
            )
        finally:
            # Hyperframes' intermediate files aren't useful after upload.
            # We don't recursively delete on error — the operator may want
            # to inspect the render dir.
            pass

        # ``rerender`` is the only enum entry that covers compose; the
        # ``video_iterations`` table doesn't track "first compose vs
        # subsequent compose" separately. The event payload captures
        # which iteration this is for downstream analytics.
        result = await record_video_stage(
            brief_id=brief_id,
            stage="composed",
            paths={"composed_path": storage_path},
            iteration_kind="rerender",
            iteration_content={
                "dimensions": dimensions,
                "captions_style": captions_style,
                "total_duration_s": scene.total_duration_s,
                "segments": len(scene.segments),
                "is_first_compose": not bool(creative.get("composed_path")),
            },
            creative_id=req.creative_id,
        )

    log.info(
        "video_compose_done",
        brief_id=brief_id,
        creative_id=req.creative_id,
        duration_s=scene.total_duration_s,
        segments=len(scene.segments),
    )
    return {
        "ok": True,
        "creative_id": result.creative_id,
        "composed_path": storage_path,
        "duration_s": scene.total_duration_s,
    }


# ---------------------------------------------------------------------------
# V2-7: /work/video/caption
# ---------------------------------------------------------------------------


class CaptionRequest(BaseModel):
    """POST body for ``/work/video/caption``."""

    creative_id: str = Field(..., min_length=1)


@router.post("/work/video/caption", dependencies=[Depends(verify_secret)])
async def caption_video(req: CaptionRequest) -> dict[str, Any]:
    """Submit the composed MP4 to Submagic and persist the captioned cut."""
    creative = _fetch_video_creative(req.creative_id)
    brief_id = _brief_id_from_creative(creative)
    brief = creative.get("video_briefs") or {}

    composed_path = creative.get("composed_path")
    if not isinstance(composed_path, str) or not composed_path:
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no composed_path yet "
            f"(run /work/video/compose first)",
        )

    captions_style = (
        brief.get("captions_style") if isinstance(brief, dict) else None
    ) or "bold_yellow"

    public_url = _sign_storage_url(composed_path)

    async with get_queue().acquire(brief_id):
        async with SubmagicClient() as client:
            try:
                result = await client.caption(public_url, style=captions_style)
            except RuntimeError as e:
                log.warning(
                    "caption_unavailable",
                    creative_id=req.creative_id,
                    error=str(e),
                )
                raise HTTPException(status_code=503, detail=str(e)) from e

        storage_path = (
            f"{brief_id}/captioned-{req.creative_id}-{uuid.uuid4().hex[:8]}.mp4"
        )
        _upload_bytes_to_storage(
            data=result.captioned_bytes,
            storage_path=storage_path,
            content_type="video/mp4",
        )

        # ``recaption`` covers both the first captioning pass and any
        # subsequent re-runs. We log ``is_first_caption`` on the
        # iteration content so downstream analytics can distinguish them.
        stage_result = await record_video_stage(
            brief_id=brief_id,
            stage="captioned",
            paths={"captioned_path": storage_path},
            iteration_kind="recaption",
            iteration_content={
                "submagic_project_id": result.project_id,
                "captions_style": captions_style,
                "is_first_caption": not bool(creative.get("captioned_path")),
            },
            creative_id=req.creative_id,
        )

    log.info(
        "video_caption_done",
        brief_id=brief_id,
        creative_id=req.creative_id,
        submagic_project_id=result.project_id,
    )
    return {
        "ok": True,
        "creative_id": stage_result.creative_id,
        "captioned_path": storage_path,
        "submagic_project_id": result.project_id,
    }


# Re-export so callers can `from .routes.video import StoredClip` without
# importing the broll_store module directly. Keeps wave-5 imports tidy.
__all__ = [
    "router",
    "VIDEO_SKILL_PATH",
    "ScriptRequest",
    "VoiceoverRequest",
    "BrollSearchRequest",
    "BrollSelectRequest",
    "ComposeRequest",
    "CaptionRequest",
    "StoredClip",
]


_ = asyncio  # keep import alive: some helpers reach into asyncio later
