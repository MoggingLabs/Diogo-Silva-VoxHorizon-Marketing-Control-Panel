"""Hyperframes scene authoring + render adapter.

V2-6 ships this as the bridge between the script + b-roll selection and a
finished MP4. Hyperframes is a Node-based CLI that takes an HTML scene
file (custom ``<hf-*>`` tags) and renders it via headless Chromium into
an MP4 with a baked-in audio track.

The HTML is templated by Jinja2 from
``worker/templates/hyperframes/voiceover-broll.html.j2``. Splitting the
template out of the Python code keeps the schema self-documenting and
makes it easy for an operator (or a designer) to tweak the look without
touching service code.

This module deliberately does NOT:

- talk to Supabase or upload the MP4 anywhere — the route layer owns that
- compute b-roll confidence — that lives in :mod:`broll_selection`
- run ffmpeg post-processing — Hyperframes' Chromium pipeline does the
  audio mux itself
"""

from __future__ import annotations

import asyncio
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import structlog
from jinja2 import Environment, FileSystemLoader, StrictUndefined

from ..config import get_settings


log = structlog.get_logger(__name__)


# Where the j2 templates live. Relative to the worker package root so
# tests in ``worker/tests`` can resolve it without env config.
TEMPLATES_DIR = Path(__file__).resolve().parent.parent.parent / "templates" / "hyperframes"
VOICEOVER_BROLL_TEMPLATE = "voiceover-broll.html.j2"


@dataclass(frozen=True)
class TimelineSegment:
    """One b-roll-backed segment on the timeline.

    ``start_s`` / ``end_s`` are absolute timeline offsets in seconds. The
    template renders ``<hf-timeline at=start until=end>`` blocks from
    these. ``broll_url`` is whatever the b-roll store handed us (signed
    HTTP URL for the local backend, public URL for supabase).
    """

    idx: int
    start_s: float
    end_s: float
    voiceover_text: str
    broll_url: str
    broll_intent: str | None = None
    captions_emphasis: tuple[str, ...] = ()


@dataclass(frozen=True)
class HyperframesScene:
    """All inputs the template needs.

    Kept distinct from the raw script JSON so the caller does the field
    extraction once, in the route, and the template never sees a stray
    field it doesn't expect.
    """

    total_duration_s: float
    dimensions: str  # e.g. "9x16"
    voiceover_url: str
    captions_style: str
    segments: tuple[TimelineSegment, ...]
    hook_text: str = ""
    cta_text: str = ""

    def as_template_ctx(self) -> dict[str, Any]:
        return {
            "total_duration_s": self.total_duration_s,
            "dimensions": self.dimensions,
            "voiceover_url": self.voiceover_url,
            "captions_style": self.captions_style,
            "hook_text": self.hook_text,
            "cta_text": self.cta_text,
            "segments": [
                {
                    "idx": s.idx,
                    "start_s": s.start_s,
                    "end_s": s.end_s,
                    "voiceover_text": s.voiceover_text,
                    "broll_url": s.broll_url,
                    "broll_intent": s.broll_intent or "",
                    "captions_emphasis": list(s.captions_emphasis),
                }
                for s in self.segments
            ],
        }


def render_scene_html(
    scene: HyperframesScene,
    *,
    templates_dir: Path | None = None,
    template_name: str = VOICEOVER_BROLL_TEMPLATE,
) -> str:
    """Render the scene template; returns the HTML string.

    Uses ``StrictUndefined`` so missing fields raise loudly during dev
    rather than silently rendering empty attributes (which would explode
    later inside Hyperframes' Chromium parse).
    """
    root = templates_dir or TEMPLATES_DIR
    env = Environment(
        loader=FileSystemLoader(str(root)),
        undefined=StrictUndefined,
        autoescape=True,
        trim_blocks=True,
        lstrip_blocks=True,
    )
    template = env.get_template(template_name)
    return template.render(**scene.as_template_ctx())


def build_timeline_from_script(
    *,
    script_outline: dict[str, Any],
    selected_clips: dict[int, str],
) -> tuple[TimelineSegment, ...]:
    """Walk the validated ``script_outline`` and pair each segment with its
    chosen b-roll URL.

    ``selected_clips`` is a ``{segment_idx: broll_url}`` mapping. Missing
    keys raise — callers should resolve every segment before composing.

    The hook's duration sits on top of the timeline (segment 0 starts AFTER
    the hook lands). The outro's duration trails the last segment.
    """
    hook = script_outline.get("hook") or ""
    segments_raw = script_outline.get("segments") or []
    if not isinstance(segments_raw, list) or not segments_raw:
        raise ValueError("script_outline.segments must be a non-empty list")

    # Hook duration is not always recorded. We default to 3s — long enough
    # to land a hook line at normal pace and short enough that we don't
    # eat a whole segment if the operator forgot to set it.
    hook_duration = float(script_outline.get("hook_duration_s") or 3.0)
    cursor = hook_duration

    out: list[TimelineSegment] = []
    for seg in segments_raw:
        if not isinstance(seg, dict):
            raise ValueError(f"segment is not an object: {seg!r}")
        idx = int(seg["idx"])
        dur = float(seg["duration_s"])
        if idx not in selected_clips:
            raise ValueError(
                f"segment idx={idx} has no selected broll clip; "
                f"resolve every segment before compose"
            )
        out.append(
            TimelineSegment(
                idx=idx,
                start_s=cursor,
                end_s=cursor + dur,
                voiceover_text=str(seg.get("voiceover_text") or ""),
                broll_url=selected_clips[idx],
                broll_intent=seg.get("broll_intent"),
                captions_emphasis=tuple(seg.get("captions_emphasis") or []),
            )
        )
        cursor += dur

    # Sanity: at least one segment, idx-contiguous from 0.
    seen = [s.idx for s in out]
    if seen != list(range(len(seen))):
        raise ValueError(f"segment idx values are not 0-contiguous: {seen!r}")

    _ = hook  # hook is rendered by the template via scene.hook_text below
    return tuple(out)


def scene_from_script(
    *,
    script_outline: dict[str, Any],
    selected_clips: dict[int, str],
    voiceover_url: str,
    dimensions: str,
    captions_style: str,
) -> HyperframesScene:
    """Build a fully-populated :class:`HyperframesScene` from the script + picks."""
    timeline = build_timeline_from_script(
        script_outline=script_outline,
        selected_clips=selected_clips,
    )
    total = float(script_outline.get("total_duration_s") or 0.0)
    if total <= 0:
        # Defensive: if the script forgot total_duration_s, compute it.
        total = (timeline[-1].end_s if timeline else 0.0)
        outro = script_outline.get("outro") or {}
        total += float(outro.get("duration_s") or 0.0)

    return HyperframesScene(
        total_duration_s=total,
        dimensions=dimensions,
        voiceover_url=voiceover_url,
        captions_style=captions_style,
        segments=timeline,
        hook_text=str(script_outline.get("hook") or ""),
        cta_text=str(((script_outline.get("outro") or {}).get("cta_overlay")) or ""),
    )


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HyperframesRenderResult:
    """What the route layer needs after a successful render."""

    scenes_html_path: Path
    output_mp4_path: Path
    stdout: str
    stderr: str


async def render_to_mp4(
    scenes_html_path: Path,
    output_mp4_path: Path,
    *,
    hyperframes_binary: str | None = None,
    extra_args: tuple[str, ...] = (),
) -> HyperframesRenderResult:
    """Spawn ``hyperframes render <scenes.html> <output.mp4>``.

    The CLI is part of Diogo's Mac toolchain and isn't installed on CI /
    WSL. We surface a clear ``RuntimeError`` if the binary is missing so
    the route layer can convert it to a 503.
    """
    binary = hyperframes_binary or shutil.which("hyperframes")
    if binary is None:
        raise RuntimeError(
            "hyperframes CLI not found on PATH — composition is unavailable "
            "in this environment. Install Hyperframes on the worker host."
        )

    output_mp4_path = output_mp4_path.expanduser().resolve()
    output_mp4_path.parent.mkdir(parents=True, exist_ok=True)

    cmd: list[str] = [
        binary,
        "render",
        str(scenes_html_path),
        str(output_mp4_path),
        *extra_args,
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out_b, err_b = await proc.communicate()
    out = out_b.decode("utf-8", errors="replace")
    err = err_b.decode("utf-8", errors="replace")

    if proc.returncode != 0:
        raise RuntimeError(
            f"hyperframes render failed (exit {proc.returncode}): "
            f"{err.strip() or out.strip()}"
        )
    return HyperframesRenderResult(
        scenes_html_path=scenes_html_path,
        output_mp4_path=output_mp4_path,
        stdout=out,
        stderr=err,
    )


async def author_and_render(
    *,
    scene: HyperframesScene,
    work_dir: Path,
    templates_dir: Path | None = None,
) -> HyperframesRenderResult:
    """Render the scene template to ``work_dir/scenes.html`` and run the CLI.

    Convenience for the route layer so it doesn't have to juggle the
    intermediate paths.
    """
    work_dir = work_dir.expanduser().resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    scenes_html = work_dir / "scenes.html"
    output_mp4 = work_dir / "composed.mp4"

    html = render_scene_html(scene, templates_dir=templates_dir)
    scenes_html.write_text(html, encoding="utf-8")
    log.info(
        "hyperframes_html_authored",
        path=str(scenes_html),
        bytes=len(html),
        segments=len(scene.segments),
        duration_s=scene.total_duration_s,
    )

    return await render_to_mp4(scenes_html, output_mp4)


__all__ = [
    "HyperframesScene",
    "HyperframesRenderResult",
    "TimelineSegment",
    "TEMPLATES_DIR",
    "VOICEOVER_BROLL_TEMPLATE",
    "render_scene_html",
    "build_timeline_from_script",
    "scene_from_script",
    "render_to_mp4",
    "author_and_render",
]


# Provide default settings hook even though most call sites don't use it —
# the route layer queries get_settings() for tmp dirs etc.
_ = get_settings
