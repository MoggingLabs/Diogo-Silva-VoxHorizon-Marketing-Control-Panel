"""Video creative pipeline routes (VID-5: rebuilt on the kie + local-ffmpeg stack).

Each stage of the video creative flow is one async handler. The pipeline's
generation dispatcher (``routes.pipeline._run_video_substage``) calls these
directly, in order, reading back the path/ids each returns; they also carry
``@router.post`` decorators for direct HTTP use. The router is intentionally NOT
wired into ``main`` (the dispatcher uses direct calls), matching the prior stub.

This is the HI-8-deleted pipeline rebuilt on the new backend (see
VIDEO-ARCHITECTURE.md). The substage chain and its persistence are unchanged; only
the per-stage backend differs from the original ``381eb4a^`` implementation:

    script       Claude + the bundled skill -> script_outline JSON (unchanged)
    voiceover    kie ElevenLabs TTS per segment + ffmpeg concat (was ElevenLabs SaaS)
    broll-search yt-dlp stock AND kie generated clips (D2: both) -> LocalBrollStore
    broll-select broll_selection scorer (unchanged)
    compose      local ffmpeg (services.ffmpeg_compose) (was Hyperframes)
    caption      Whisper -> ASS -> ffmpeg burn-in (services.captions) (was Submagic)

Spend (D1): the only paid stage is broll-search's kie generation. It estimates the
cost up front and aborts (HTTP 402) if it would exceed the brief's per-ad budget,
the hard worker-side cap; the operator threshold gate is enforced separately at the
``video_render`` tool. Every stage ends with one ``record_video_stage`` write.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any, Literal

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException
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
from ..services.captions import caption_video as burn_captions_into_video
from ..services.claude_runner import ClaudeRunner
from ..services.ffmpeg_compose import compose as ffmpeg_compose
from ..services.kie_tts import KieTtsClient
from ..services.kie_video import DEFAULT_VIDEO_MODEL, KieVideoClient
from ..services.queue import get_queue
from ..services.storage import BUCKET
from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


router = APIRouter()


# The bundled worker-side script skill (still present under worker/skills/).
VIDEO_SKILL_PATH = (
    Path(__file__).resolve().parent.parent.parent / "skills" / "video-voiceover-broll"
)

# D1 per-ad spend cap. A brief may lower it via ``payload.budget_usd``; this is the
# ceiling the worker enforces before any kie generation submit (kie has no upstream
# per-render cap). Rough per-clip estimate for the default Veo Fast tier.
DEFAULT_PER_AD_BUDGET_USD = 5.0
EST_COST_PER_GENERATED_CLIP_USD = 0.40


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _supabase():  # noqa: ANN202
    return get_supabase_admin()


def _fetch_video_brief(brief_id: str) -> dict[str, Any]:
    resp = (
        _supabase()
        .table("video_briefs")
        .select("*, clients(slug, name)")
        .eq("id", brief_id)
        .maybe_single()
        .execute()
    )
    row = resp.data if resp is not None else None
    if not row:
        raise HTTPException(status_code=404, detail=f"video brief not found: {brief_id}")
    return row


def _fetch_video_creative(creative_id: str) -> dict[str, Any]:
    resp = (
        _supabase()
        .table("video_creatives")
        .select("*, video_briefs(*)")
        .eq("id", creative_id)
        .maybe_single()
        .execute()
    )
    row = resp.data if resp is not None else None
    if not row:
        raise HTTPException(
            status_code=404, detail=f"video creative not found: {creative_id}"
        )
    return row


def _brief_id_from_creative(creative: dict[str, Any]) -> str:
    bid = creative.get("brief_id")
    if not isinstance(bid, str) or not bid:
        raise HTTPException(
            status_code=409,
            detail=f"video creative {creative.get('id')!r} has no brief_id",
        )
    return bid


def _script_of(creative: dict[str, Any], brief: dict[str, Any]) -> dict[str, Any]:
    """Resolve the script_outline from the creative or (fallback) the brief."""
    script = creative.get("script_outline")
    if not isinstance(script, dict) or not script.get("segments"):
        payload = brief.get("payload") if isinstance(brief, dict) else None
        script = (payload or {}).get("script_outline")
    if not isinstance(script, dict) or not script.get("segments"):
        raise HTTPException(
            status_code=409,
            detail=f"creative {creative.get('id')} has no script_outline yet",
        )
    return script


def _upload_to_storage(
    *, local_path: Path, storage_path: str, content_type: str, bucket: str = BUCKET
) -> str:
    if not local_path.exists():
        raise FileNotFoundError(f"local_path does not exist: {local_path}")
    sb = _supabase()
    sb.storage.from_(bucket).upload(
        path=storage_path,
        file=local_path.read_bytes(),
        file_options={"content-type": content_type, "x-upsert": "true"},
    )
    return storage_path


def _sign_storage_url(storage_path: str, ttl_s: int = 3600, bucket: str = BUCKET) -> str:
    payload = _supabase().storage.from_(bucket).create_signed_url(storage_path, ttl_s)
    if isinstance(payload, dict):
        for key in ("signedURL", "signedUrl", "signed_url"):
            if isinstance(payload.get(key), str):
                return payload[key]
    raise RuntimeError(f"unexpected signed-url response: {payload!r}")


async def _download_to_file(url: str, dest: Path) -> Path:
    """Stream a remote URL to a local file (for the in-container ffmpeg)."""
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        resp = await client.get(url)
        if resp.status_code >= 400:
            raise HTTPException(
                status_code=502, detail=f"download {url} responded {resp.status_code}"
            )
        dest.write_bytes(resp.content)
    return dest


async def _ffmpeg_concat_audio(parts: list[Path], output: Path) -> Path:
    """Concatenate N audio files into one track via the ffmpeg concat filter."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise HTTPException(status_code=503, detail="ffmpeg not found for audio concat")
    argv: list[str] = [ffmpeg, "-y"]
    for p in parts:
        argv += ["-i", str(p)]
    n = len(parts)
    streams = "".join(f"[{i}:a]" for i in range(n))
    argv += [
        "-filter_complex",
        f"{streams}concat=n={n}:v=0:a=1[aout]",
        "-map",
        "[aout]",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "3",
        str(output),
    ]
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    _o, err_b = await proc.communicate()
    if proc.returncode != 0 or not output.exists():
        raise HTTPException(
            status_code=502,
            detail=f"audio concat failed: {err_b.decode('utf-8', 'replace')[-300:]}",
        )
    return output


def _per_ad_budget(brief: dict[str, Any]) -> float:
    payload = brief.get("payload") if isinstance(brief, dict) else None
    budget = (payload or {}).get("budget_usd")
    if isinstance(budget, (int, float)) and budget > 0:
        return float(budget)
    return DEFAULT_PER_AD_BUDGET_USD


# ---------------------------------------------------------------------------
# script
# ---------------------------------------------------------------------------


class ScriptRequest(BaseModel):
    brief_id: str = Field(..., min_length=1)


def _build_script_prompt(brief: dict[str, Any]) -> str:
    payload = brief.get("payload") or {}
    return (
        "You are running the `video-ad-authoring` skill. Generate the "
        "production-ready script JSON object for the brief below. Return ONLY the "
        "JSON object specified by the skill output schema. No prose, no markdown "
        "fence.\n\n"
        f"```json\n{json.dumps({'brief': brief, 'payload': payload}, default=str)}\n```"
    )


def _parse_script_output(raw: str) -> dict[str, Any]:
    """Validate the agent's script JSON against the worker schema (ported)."""
    text = raw.strip()
    if text.startswith("```"):
        lines = text.splitlines()[1:]
        while lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=502, detail=f"script generator returned invalid JSON: {e.msg}"
        ) from e
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=502, detail="script generator output is not a JSON object"
        )
    missing = {"hook", "segments", "outro", "total_duration_s"} - set(payload)
    if missing:
        raise HTTPException(
            status_code=502,
            detail=f"script output missing required keys: {sorted(missing)}",
        )
    segments = payload["segments"]
    if not isinstance(segments, list) or not (1 <= len(segments) <= 4):
        raise HTTPException(
            status_code=502, detail="script `segments` must be a list of 1-4 entries"
        )
    for i, seg in enumerate(segments):
        if not isinstance(seg, dict):
            raise HTTPException(status_code=502, detail=f"segment[{i}] is not an object")
        for key in (
            "idx", "topic", "duration_s", "voiceover_text", "voiceover_direction",
            "broll_query", "broll_intent", "captions_emphasis",
        ):
            if key not in seg:
                raise HTTPException(
                    status_code=502, detail=f"segment[{i}] missing required key: {key}"
                )
    idxs = [int(s["idx"]) for s in segments]
    if idxs != list(range(len(idxs))):
        raise HTTPException(
            status_code=502, detail=f"segment idx values not 0-contiguous: {idxs!r}"
        )
    return payload


@router.post("/work/video/script", dependencies=[Depends(verify_secret)])
async def generate_script(req: ScriptRequest) -> dict[str, Any]:
    """Generate + persist the script_outline JSON for a video brief."""
    brief = _fetch_video_brief(req.brief_id)
    async with get_queue().acquire(req.brief_id):
        prompt = _build_script_prompt(brief)
        try:
            raw = await ClaudeRunner().run_subprocess(prompt, cwd=str(VIDEO_SKILL_PATH))
        except NotImplementedError as e:
            raise HTTPException(status_code=501, detail=str(e)) from e
        script_outline = _parse_script_output(raw)
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
            tmp_path.unlink(missing_ok=True)
        result = await record_video_stage(
            brief_id=req.brief_id,
            stage="script",
            # Persist the generated script on the creative (0033) so the
            # voiceover stage's `_script_of` primary path resolves it and the
            # compliance gate reads the exact spoken text it will synthesize.
            paths={"script_path": storage_path, "script_outline": script_outline},
            iteration_kind="generate_script",
            iteration_content={"prompt": prompt, "output": script_outline},
        )
    log.info("video_script_done", brief_id=req.brief_id, creative_id=result.creative_id)
    return {
        "ok": True,
        "creative_id": result.creative_id,
        "script_path": storage_path,
        "script_outline": script_outline,
    }


# ---------------------------------------------------------------------------
# voiceover (kie ElevenLabs TTS per segment + ffmpeg concat)
# ---------------------------------------------------------------------------


class VoiceoverRequest(BaseModel):
    creative_id: str = Field(..., min_length=1)
    speed: float = 1.0


@router.post("/work/video/voiceover", dependencies=[Depends(verify_secret)])
async def synthesize_voiceover(req: VoiceoverRequest) -> dict[str, Any]:
    """Synthesize per-segment voiceover via kie TTS and concat into one track."""
    creative = _fetch_video_creative(req.creative_id)
    brief_id = _brief_id_from_creative(creative)
    brief = creative.get("video_briefs") or {}
    script = _script_of(creative, brief)

    voice_id = creative.get("voice_id") or (
        brief.get("voice_id") if isinstance(brief, dict) else None
    )
    if not isinstance(voice_id, str) or not voice_id:
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no voice_id (set it on the brief)",
        )

    async with get_queue().acquire(brief_id):
        client = KieTtsClient()
        work_dir = Path(tempfile.mkdtemp(prefix="vox-vo-"))
        seg_files: list[Path] = []
        for seg in sorted(script["segments"], key=lambda s: int(s["idx"])):
            text = str(seg.get("voiceover_text") or "").strip()
            if not text:
                raise HTTPException(
                    status_code=409,
                    detail=f"segment[{seg.get('idx')}] has empty voiceover_text",
                )
            try:
                tts = await client.synthesize(text, voice=voice_id, speed=req.speed)
                audio = await client.download_audio(tts.audio_url)
            except Exception as e:  # noqa: BLE001 - surface vendor failure as 502
                raise HTTPException(
                    status_code=502, detail=f"voiceover TTS failed: {e}"
                ) from e
            part = work_dir / f"seg-{int(seg['idx']):02d}.mp3"
            part.write_bytes(audio)
            seg_files.append(part)

        concat_path = work_dir / "voiceover.mp3"
        if len(seg_files) == 1:
            concat_path.write_bytes(seg_files[0].read_bytes())
        else:
            await _ffmpeg_concat_audio(seg_files, concat_path)

        storage_path = (
            f"{brief_id}/voiceover-{req.creative_id}-{uuid.uuid4().hex[:8]}.mp3"
        )
        _upload_to_storage(
            local_path=concat_path, storage_path=storage_path, content_type="audio/mpeg"
        )
        existed = bool(creative.get("voiceover_path"))
        result = await record_video_stage(
            brief_id=brief_id,
            stage="voiceover",
            paths={"voiceover_path": storage_path},
            iteration_kind="regenerate_voiceover" if existed else "generate_script",
            iteration_content={
                "voice_id": voice_id,
                "speed": req.speed,
                "segments": len(seg_files),
            },
            creative_id=req.creative_id,
        )
    log.info("video_voiceover_done", creative_id=req.creative_id, segments=len(seg_files))
    return {"ok": True, "creative_id": result.creative_id, "voiceover_path": storage_path}


# ---------------------------------------------------------------------------
# broll-search (D2: yt-dlp stock AND kie generated clips, both stored)
# ---------------------------------------------------------------------------


class BrollSearchRequest(BaseModel):
    creative_id: str = Field(..., min_length=1)
    per_segment: int = 5


def _estimate_generation_cost(num_segments: int) -> float:
    return num_segments * EST_COST_PER_GENERATED_CLIP_USD


@router.post("/work/video/broll-search", dependencies=[Depends(verify_secret)])
async def search_broll(req: BrollSearchRequest) -> dict[str, Any]:
    """Gather b-roll candidates per segment from BOTH stock (yt-dlp) and kie gen.

    The kie generation is the only paid step in the chain; its estimated cost is
    checked against the brief's per-ad budget BEFORE any submit (D1 hard cap).
    """
    creative = _fetch_video_creative(req.creative_id)
    brief_id = _brief_id_from_creative(creative)
    brief = creative.get("video_briefs") or {}
    script = _script_of(creative, brief)
    segments = sorted(script["segments"], key=lambda s: int(s["idx"]))

    # D1 hard cap: refuse before spending if generating one clip per segment
    # would blow the per-ad budget.
    est = _estimate_generation_cost(len(segments))
    budget = _per_ad_budget(brief)
    if est > budget:
        raise HTTPException(
            status_code=402,
            detail=(
                f"estimated generation cost ${est:.2f} exceeds per-ad budget "
                f"${budget:.2f} ({len(segments)} clips x "
                f"${EST_COST_PER_GENERATED_CLIP_USD:.2f}); lower the segment count "
                f"or raise payload.budget_usd"
            ),
        )

    store = get_broll_store()
    video_client = KieVideoClient()
    candidates_by_segment: dict[str, list[dict[str, Any]]] = {}

    async with get_queue().acquire(brief_id):
        for seg in segments:
            idx = int(seg["idx"])
            query = str(seg.get("broll_query") or "").strip()
            theme = str(seg.get("broll_theme") or seg.get("topic") or "").strip()
            if not query:
                raise HTTPException(
                    status_code=409, detail=f"segment[{idx}] has empty broll_query"
                )
            stored: list[dict[str, Any]] = []

            # (a) Generated clip (kie). Abstract footage; keep it license-clean.
            try:
                gen = await video_client.generate_video(
                    query, model=DEFAULT_VIDEO_MODEL, aspect_ratio="9x16", duration=8
                )
                gbytes = await video_client.download_video(gen.video_url)
                if gbytes:
                    gtmp = Path(tempfile.mkdtemp(prefix="vox-gen-")) / f"gen-{idx}.mp4"
                    gtmp.write_bytes(gbytes)
                    sc: StoredClip = await store.put(
                        gen.video_url, gtmp, theme=theme or None
                    )
                    stored.append(sc.to_dict())
            except Exception as e:  # noqa: BLE001 - gen failure non-fatal; stock still runs
                log.warning("broll_generate_failed", segment_idx=idx, error=str(e))

            # (b) Stock clips (yt-dlp). Unavailability is non-fatal if (a) yielded.
            try:
                scraped = await scrape_yt_shorts(query, count=req.per_segment)
                for cand in scraped:
                    sc = await store.put(
                        cand.source_url,
                        cand.local_path,
                        theme=theme or None,
                        duration_s=cand.duration_s,
                        dimensions=cand.dimensions,
                    )
                    stored.append(sc.to_dict())
            except RuntimeError as e:
                log.warning("broll_search_unavailable", segment_idx=idx, error=str(e))

            if not stored:
                raise HTTPException(
                    status_code=503,
                    detail=f"segment[{idx}] produced no b-roll (generation + stock both failed)",
                )
            candidates_by_segment[str(idx)] = stored

        result = await record_video_stage(
            brief_id=brief_id,
            stage="broll_search",
            paths={"broll_clips": {"candidates": candidates_by_segment}},
            iteration_kind="search_broll",
            iteration_content={"candidates_by_segment": candidates_by_segment},
            creative_id=req.creative_id,
        )
    log.info(
        "video_broll_search_done",
        creative_id=req.creative_id,
        segments=len(candidates_by_segment),
        total=sum(len(v) for v in candidates_by_segment.values()),
    )
    return {
        "ok": True,
        "creative_id": result.creative_id,
        "candidates": candidates_by_segment,
    }


# ---------------------------------------------------------------------------
# broll-select (deterministic scorer; unchanged from the original)
# ---------------------------------------------------------------------------


class BrollSelectRequest(BaseModel):
    creative_id: str = Field(..., min_length=1)
    mode: Literal["auto", "review_each", "review_low_confidence"] | None = None
    allow_review_low_confidence: bool = False


def _coerce_candidates_for_selection(
    raw: dict[str, list[dict[str, Any]]],
) -> dict[int, list[SelectionCandidate]]:
    out: dict[int, list[SelectionCandidate]] = {}
    for key, clips in raw.items():
        try:
            idx = int(key)
        except (ValueError, TypeError) as e:
            raise HTTPException(
                status_code=409, detail=f"non-int candidate segment key: {key!r}"
            ) from e
        out[idx] = [
            SelectionCandidate(
                clip_id=str(c.get("clip_id") or ""),
                source_url=str(c.get("source_url") or ""),
                theme=c.get("theme"),
                duration_s=c.get("duration_s"),
                dimensions=c.get("dimensions"),
            )
            for c in clips
        ]
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
    """Apply the brief's broll_selection_mode to the shortlist."""
    creative = _fetch_video_creative(req.creative_id)
    brief_id = _brief_id_from_creative(creative)
    brief = creative.get("video_briefs") or {}
    script = _script_of(creative, brief)

    raw_clips = creative.get("broll_clips") or {}
    candidates = raw_clips.get("candidates") if isinstance(raw_clips, dict) else None
    if not isinstance(candidates, dict) or not candidates:
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no broll candidates (run broll-search)",
        )

    mode: SelectionMode = (
        req.mode
        or (brief.get("broll_selection_mode") if isinstance(brief, dict) else None)
        or "auto"
    )
    if mode not in VALID_MODES:
        raise HTTPException(
            status_code=400, detail=f"unknown broll_selection_mode: {mode!r}"
        )

    try:
        selection: SelectionResult = apply_selection_mode(
            mode=mode,
            candidates=_coerce_candidates_for_selection(candidates),
            segments=_segments_from_script(script),
            allow_review_low_confidence=req.allow_review_low_confidence,
        )
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e)) from e

    async with get_queue().acquire(brief_id):
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
        result = await record_video_stage(
            brief_id=brief_id,
            stage="broll_pick" if selection.resolved else "broll_search",
            paths={"broll_clips": selection_payload},
            iteration_kind="swap_broll" if selection.resolved else "search_broll",
            iteration_content={"mode": mode, "selection": selection.to_dict()},
            creative_id=req.creative_id,
        )
    log.info(
        "video_broll_select_done",
        creative_id=req.creative_id,
        mode=mode,
        resolved=len(selection.resolved),
    )
    return {"ok": True, "creative_id": result.creative_id, **selection.to_dict()}


# ---------------------------------------------------------------------------
# compose (local ffmpeg)
# ---------------------------------------------------------------------------


class ComposeRequest(BaseModel):
    creative_id: str = Field(..., min_length=1)


def _local_clip_for(candidates: dict[str, Any], idx: int, clip_id: str) -> str | None:
    """Find a selected clip's on-disk local_path in the stored candidates."""
    for c in candidates.get(str(idx)) or []:
        if isinstance(c, dict) and c.get("clip_id") == clip_id:
            lp = c.get("local_path")
            return lp if isinstance(lp, str) and lp else None
    return None


@router.post("/work/video/compose", dependencies=[Depends(verify_secret)])
async def compose_video(req: ComposeRequest) -> dict[str, Any]:
    """Assemble selected clips + voiceover into a composed 9:16 MP4 (local ffmpeg)."""
    creative = _fetch_video_creative(req.creative_id)
    brief_id = _brief_id_from_creative(creative)

    voiceover_path = creative.get("voiceover_path")
    if not isinstance(voiceover_path, str) or not voiceover_path:
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no voiceover yet (run voiceover)",
        )
    raw_clips = creative.get("broll_clips") or {}
    selected = raw_clips.get("selected") if isinstance(raw_clips, dict) else None
    candidates = raw_clips.get("candidates") if isinstance(raw_clips, dict) else {}
    if not isinstance(selected, dict) or not selected:
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no resolved broll clips (run broll-select)",
        )

    store = get_broll_store()
    work_dir = Path(tempfile.mkdtemp(prefix="vox-compose-"))

    # Resolve each selected clip to a local file: prefer the on-disk local_path
    # (local store backend), else download its signed URL.
    clip_paths: list[Path] = []
    for key in sorted(selected, key=lambda k: int(k)):
        idx = int(key)
        sel = selected[key]
        clip_id = sel.get("clip_id") if isinstance(sel, dict) else None
        if not isinstance(clip_id, str) or not clip_id:
            raise HTTPException(
                status_code=409, detail=f"selected clip for segment[{idx}] has no clip_id"
            )
        local = _local_clip_for(
            candidates if isinstance(candidates, dict) else {}, idx, clip_id
        )
        if local and Path(local).exists():
            clip_paths.append(Path(local))
        else:
            dest = work_dir / f"clip-{idx:02d}.mp4"
            await _download_to_file(await store.get_signed_url(clip_id), dest)
            clip_paths.append(dest)

    vo_local = work_dir / "voiceover.mp3"
    await _download_to_file(_sign_storage_url(voiceover_path), vo_local)

    output = work_dir / "composed.mp4"
    try:
        composed = await ffmpeg_compose(
            clips=clip_paths, output=output, voiceover=vo_local
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    async with get_queue().acquire(brief_id):
        storage_path = (
            f"{brief_id}/composed-{req.creative_id}-{uuid.uuid4().hex[:8]}.mp4"
        )
        _upload_to_storage(
            local_path=composed.output_path,
            storage_path=storage_path,
            content_type="video/mp4",
        )
        result = await record_video_stage(
            brief_id=brief_id,
            stage="composed",
            paths={"composed_path": storage_path},
            iteration_kind="rerender",
            iteration_content={
                "clips": len(clip_paths),
                "is_first": not bool(creative.get("composed_path")),
            },
            creative_id=req.creative_id,
        )
    log.info("video_compose_done", creative_id=req.creative_id, clips=len(clip_paths))
    return {"ok": True, "creative_id": result.creative_id, "composed_path": storage_path}


# ---------------------------------------------------------------------------
# caption (Whisper -> ASS -> ffmpeg burn-in)
# ---------------------------------------------------------------------------


class CaptionRequest(BaseModel):
    creative_id: str = Field(..., min_length=1)


@router.post("/work/video/caption", dependencies=[Depends(verify_secret)])
async def caption_video(req: CaptionRequest) -> dict[str, Any]:
    """Burn captions into the composed MP4 (Whisper timings + ffmpeg)."""
    creative = _fetch_video_creative(req.creative_id)
    brief_id = _brief_id_from_creative(creative)

    composed_path = creative.get("composed_path")
    if not isinstance(composed_path, str) or not composed_path:
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no composed_path yet (run compose)",
        )
    voiceover_path = creative.get("voiceover_path")
    if not isinstance(voiceover_path, str) or not voiceover_path:
        raise HTTPException(
            status_code=409,
            detail=f"creative {req.creative_id} has no voiceover for caption timing",
        )

    work_dir = Path(tempfile.mkdtemp(prefix="vox-caption-"))
    video_local = await _download_to_file(
        _sign_storage_url(composed_path), work_dir / "in.mp4"
    )
    audio_local = await _download_to_file(
        _sign_storage_url(voiceover_path), work_dir / "vo.mp3"
    )
    output = work_dir / "captioned.mp4"
    try:
        res = await burn_captions_into_video(
            video=video_local, audio=audio_local, output=output
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    async with get_queue().acquire(brief_id):
        storage_path = (
            f"{brief_id}/captioned-{req.creative_id}-{uuid.uuid4().hex[:8]}.mp4"
        )
        _upload_to_storage(
            local_path=res.output_path,
            storage_path=storage_path,
            content_type="video/mp4",
        )
        stage_result = await record_video_stage(
            brief_id=brief_id,
            stage="captioned",
            paths={"captioned_path": storage_path},
            iteration_kind="recaption",
            iteration_content={
                "cues": res.cue_count,
                "is_first": not bool(creative.get("captioned_path")),
            },
            creative_id=req.creative_id,
        )
    log.info("video_caption_done", creative_id=req.creative_id, cues=res.cue_count)
    return {
        "ok": True,
        "creative_id": stage_result.creative_id,
        "captioned_path": storage_path,
    }


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
    "generate_script",
    "synthesize_voiceover",
    "search_broll",
    "select_broll",
    "compose_video",
    "caption_video",
]
