"""Bridge to ``creative-tools/image_compositor.py``.

The upstream compositor lives at
``~/github/voxhorizon-marketing-dept/scripts/creative-tools/image_compositor.py``.
It composites text overlays, logos, and colored banners on a base image
to produce a Meta-ready creative. We invoke it as a subprocess; this
module is a thin transport.

The "composite" operation maps onto a derivative creative — same
``brief_id`` but a new version, with ``kind="annotate"`` on the iteration
row (the closest enum match for "this is a styled variant of an
existing image").

Failure modes:
 - ``RuntimeError`` when the upstream script can't be located (CI / WSL
   without the marketing-dept checkout). Routes translate to 503.
 - ``CompositorError`` when the script ran but reported failure (bad
   inputs, missing fonts, exit code != 0).
"""

from __future__ import annotations

import asyncio
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import structlog


log = structlog.get_logger(__name__)


# Mirror the upstream STYLES dict — keep the union tight so callers can't
# pass an unsupported style by accident.
CompositorStyle = Literal["bold-bottom", "offer-banner", "full-overlay", "minimal"]


# Default location of the upstream marketing-dept scripts checkout. Tests
# monkey-patch this attribute so they don't depend on the upstream repo
# being present in the test sandbox.
DEFAULT_SCRIPTS_ROOT = Path("~/github/voxhorizon-marketing-dept/scripts").expanduser()


class CompositorError(RuntimeError):
    """Raised when image_compositor.py exits non-zero or produces no output."""


@dataclass(frozen=True)
class CompositorResult:
    """Outcome of one ``composite`` call.

    ``output_path`` is the file the script wrote (we always pass an
    explicit ``--output`` so we know where it landed).
    ``raw_stdout`` / ``raw_stderr`` are kept for debugging.
    """

    output_path: Path
    raw_stdout: str
    raw_stderr: str


def _resolve_compositor_script(scripts_root: Path | None = None) -> Path | None:
    """Locate ``image_compositor.py`` under the marketing-dept checkout."""
    root = scripts_root if scripts_root is not None else DEFAULT_SCRIPTS_ROOT
    candidate = root / "creative-tools" / "image_compositor.py"
    return candidate if candidate.exists() else None


async def composite(
    input_path: Path,
    output_path: Path,
    *,
    style: CompositorStyle = "bold-bottom",
    headline: str | None = None,
    subtext: str | None = None,
    cta: str | None = None,
    offer_bar: str | None = None,
    city: str | None = None,
    logo_path: Path | None = None,
    color: str | None = None,
    accent_color: str | None = None,
    output_format: Literal["1x1", "9x16", "both"] = "1x1",
    scripts_root: Path | None = None,
) -> CompositorResult:
    """Composite a base image with headline / CTA / overlay styling.

    Wraps ``image_compositor.py``. The script always requires ``--base``
    and ``--headline``; everything else is optional. We pass ``--format
    1x1`` by default — callers that want 9x16 explicitly pass it (and
    can use ``both`` to render both at once, in which case
    ``output_path`` is the stem and the script writes two files with
    the format suffix).

    Raises:
      RuntimeError: upstream script not installed (route translates to 503).
      CompositorError: script returned non-zero or wrote nothing.
    """
    script = _resolve_compositor_script(scripts_root)
    if script is None:
        raise RuntimeError(
            "image_compositor.py not found under "
            f"{scripts_root or DEFAULT_SCRIPTS_ROOT} — install the "
            "voxhorizon-marketing-dept scripts repo before compositing."
        )
    if not input_path.exists():
        raise CompositorError(f"input_path does not exist: {input_path}")
    if not headline:
        raise CompositorError("headline is required for composite()")

    python_exe = shutil.which("python3") or shutil.which("python") or sys.executable

    cmd: list[str] = [
        python_exe,
        str(script),
        "--base",
        str(input_path),
        "--headline",
        headline,
        "--style",
        style,
        "--format",
        output_format,
        "--output",
        str(output_path),
    ]

    if subtext:
        cmd += ["--subtext", subtext]
    if cta:
        cmd += ["--cta", cta]
    if offer_bar:
        cmd += ["--offer-bar", offer_bar]
    if city:
        cmd += ["--city", city]
    if logo_path:
        cmd += ["--logo", str(logo_path)]
    if color:
        cmd += ["--color", color]
    if accent_color:
        cmd += ["--accent-color", accent_color]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out_b, err_b = await proc.communicate()
    stdout = out_b.decode("utf-8", errors="replace")
    stderr = err_b.decode("utf-8", errors="replace")

    if proc.returncode != 0:
        log.warning(
            "image_compositor_failed",
            returncode=proc.returncode,
            stderr_tail=stderr[-500:],
        )
        raise CompositorError(
            f"image_compositor.py exited {proc.returncode}: "
            f"{stderr.strip() or stdout.strip() or 'no output'}"
        )

    # The script writes to ``output_path`` directly when --format is 1x1
    # or 9x16; for "both" it suffixes the stem. We resolve back to the
    # actual file the caller asked for.
    if output_format in ("1x1", "9x16"):
        resolved = output_path
    else:
        # "both" — return whichever exists, preferring 1x1 (the more
        # commonly used Meta ratio).
        stem = output_path.with_suffix("")
        suffix = output_path.suffix or ".png"
        cand_1 = stem.parent / f"{stem.name}_1x1{suffix}"
        cand_2 = stem.parent / f"{stem.name}_9x16{suffix}"
        resolved = cand_1 if cand_1.exists() else cand_2

    if not resolved.exists():
        raise CompositorError(
            f"image_compositor.py reported success but {resolved} not written. "
            f"stdout={stdout.strip()[:200]} stderr={stderr.strip()[:200]}"
        )

    log.info(
        "image_compositor_ok",
        output=str(resolved),
        style=style,
        format=output_format,
        bytes=resolved.stat().st_size,
    )

    return CompositorResult(
        output_path=resolved,
        raw_stdout=stdout,
        raw_stderr=stderr,
    )
