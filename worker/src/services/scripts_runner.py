"""Bridge to the voxhorizon-marketing-dept scripts repo.

Stub for M0. The real implementation in M2 will shell out to:
    ~/github/voxhorizon-marketing-dept/scripts/<name>.{sh,py,ts}

for image generation, video assembly, b-roll scraping, etc. — capturing
stdout/stderr and surfacing structured progress events back to the caller.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal


# Default location of the upstream marketing-dept scripts checkout. Diogo
# pins this on his machine; CI / WSL agents may not have it — callers must
# gracefully handle the missing-path case (see `run_launch_package_validate`).
DEFAULT_SCRIPTS_ROOT = Path("~/github/voxhorizon-marketing-dept/scripts").expanduser()


class ScriptsRunner:
    """Stub. Real impl lands in M2."""

    def __init__(
        self,
        scripts_root: Path = DEFAULT_SCRIPTS_ROOT,
    ) -> None:
        self.scripts_root = scripts_root

    async def run(self, name: str, args: list[str] | None = None) -> str:
        raise NotImplementedError("ScriptsRunner.run lands in M2.")


# ---------------------------------------------------------------------------
# Wave 4: launch_package.py adapter
# ---------------------------------------------------------------------------


# Format flag passed into upstream `launch_package.py`. The two verticals
# share the same script with a `--format` flag.
LaunchFormat = Literal["image", "video"]


@dataclass(frozen=True)
class LaunchValidationResult:
    """Outcome of running the upstream ``launch_package.py validate`` step.

    ``ok`` is the binary go/no-go signal. ``issues`` is a free-form list of
    operator-facing strings — pulled from stdout when the script prints
    JSON, or fabricated from the exit code + stderr when it doesn't. The
    full raw stdout/stderr are kept on ``raw_stdout`` / ``raw_stderr`` so
    debugging is possible without re-running the script.
    """

    ok: bool
    issues: list[str]
    raw_stdout: str
    raw_stderr: str


def _resolve_launch_package_script(
    scripts_root: Path | None = None,
) -> Path | None:
    """Locate ``launch_package.py`` under the marketing-dept checkout.

    Returns ``None`` when the upstream repo is missing. The route layer
    converts that to a structured 503 so the operator sees a clear
    "validator unavailable" error rather than a stack trace.

    ``scripts_root`` resolves to the module-level ``DEFAULT_SCRIPTS_ROOT``
    at call time (NOT at import time) so tests can monkey-patch the module
    attribute and have it take effect.
    """
    root = scripts_root if scripts_root is not None else DEFAULT_SCRIPTS_ROOT
    candidate = root / "campaign-ops" / "launch_package.py"
    return candidate if candidate.exists() else None


async def run_launch_package_validate(
    *,
    brief_id: str,
    format: LaunchFormat,
    payload: dict[str, Any] | None = None,
    scripts_root: Path | None = None,
) -> LaunchValidationResult:
    """Run ``launch_package.py validate --brief-id <id> --format <fmt>``.

    The upstream script is the source of truth for whether all the pieces
    of a launch are wired correctly (Drive paths, copy paired with each
    creative, targeting+budget present, etc.). We invoke it as a
    subprocess; the worker is just a thin transport.

    The launch payload is piped to the script on stdin as JSON so the
    upstream code doesn't need to hit Supabase itself.

    Raises ``RuntimeError`` (translated to 503 upstream) if the script
    isn't installed.
    """
    script = _resolve_launch_package_script(scripts_root)
    if script is None:
        raise RuntimeError(
            "launch_package.py not found under "
            f"{scripts_root} — install the voxhorizon-marketing-dept scripts "
            "repo (Mac toolchain) before validating launches."
        )

    python_exe = shutil.which("python3") or shutil.which("python") or sys.executable

    cmd = [
        python_exe,
        str(script),
        "validate",
        "--brief-id",
        brief_id,
        "--format",
        format,
        "--stdin-payload",
    ]

    body_bytes = json.dumps(payload or {}).encode("utf-8")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out_b, err_b = await proc.communicate(input=body_bytes)
    out = out_b.decode("utf-8", errors="replace")
    err = err_b.decode("utf-8", errors="replace")

    # The script SHOULD emit `{ "ok": bool, "issues": [str, ...] }` on
    # stdout. If it doesn't, fall back to exit-code based interpretation.
    issues: list[str] = []
    ok = proc.returncode == 0
    try:
        parsed = json.loads(out.strip().splitlines()[-1]) if out.strip() else None
    except (ValueError, IndexError):
        parsed = None
    if isinstance(parsed, dict) and "ok" in parsed:
        ok = bool(parsed["ok"])
        raw_issues = parsed.get("issues") or []
        if isinstance(raw_issues, list):
            issues = [str(i) for i in raw_issues]
    elif not ok:
        # No JSON, non-zero exit. Surface stderr verbatim as a single issue.
        issues = [err.strip() or out.strip() or f"launch_package.py exited {proc.returncode}"]

    return LaunchValidationResult(
        ok=ok,
        issues=issues,
        raw_stdout=out,
        raw_stderr=err,
    )


# ---------------------------------------------------------------------------
# Wave 5: kie + image_compositor helpers
# ---------------------------------------------------------------------------
#
# These helpers are thin convenience wrappers around the real services
# in :mod:`worker.src.services.kie` and
# :mod:`worker.src.services.image_compositor`. They exist so the route
# layer has a single import surface (``from ..services import scripts_runner``)
# and so future scripts can be added without touching the routes again.
# The existing launch_package helpers above are untouched.


async def run_kie_generate(
    *,
    prompt: str,
    ratio: Literal["1x1", "9x16"],
    resolution: Literal["1K", "2K", "4K"] = "2K",
    api_key: str | None = None,
) -> bytes:
    """Generate one Kie.ai image; return the raw image bytes.

    Thin re-export of :meth:`KieClient.generate_image` — primarily used by
    tests that want to mock the scripts_runner surface rather than the
    KieClient class directly.
    """
    from .kie import KieClient

    client = KieClient(api_key=api_key)
    return await client.generate_image(prompt, ratio, resolution=resolution)


async def run_image_composite(
    input_path: Path,
    output_path: Path,
    *,
    style: str = "bold-bottom",
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
) -> Path:
    """Composite a base image; return the path to the written file.

    Thin wrapper over :func:`image_compositor.composite` that returns just
    the output path (the most common need at the route layer).
    """
    # Import inline so tests that don't exercise this path don't pay the
    # import cost of the image_compositor module.
    from typing import cast

    from . import image_compositor as ic

    result = await ic.composite(
        input_path,
        output_path,
        style=cast(ic.CompositorStyle, style),
        headline=headline,
        subtext=subtext,
        cta=cta,
        offer_bar=offer_bar,
        city=city,
        logo_path=logo_path,
        color=color,
        accent_color=accent_color,
        output_format=output_format,
        scripts_root=scripts_root,
    )
    return result.output_path
