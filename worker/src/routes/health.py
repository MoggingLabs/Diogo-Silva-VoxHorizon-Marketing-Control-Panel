"""GET /work/health — liveness + capability probe.

Authed like everything else. Returns enough information for the Next.js
side to render a "worker status" panel without making a separate round-trip.

Wave 19 trimmed this down: the legacy per-brief queue is gone (Hermes
kanban owns long-running orchestration now), so the response no longer
carries ``queue_depth``. Instead we surface the Hermes bridge status
(container running/not-found/error) so the dashboard can show whether
the colocated agent is reachable.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from typing import Any

from fastapi import APIRouter, Depends

from ..auth import verify_secret
from ..config import Settings, get_settings
from ..services.hermes_bridge import HermesBridge


router = APIRouter()

_PROCESS_STARTED_AT = time.time()

# Single shared bridge for the healthcheck so we don't reconnect to the
# Docker socket on every probe. The bridge is otherwise stateless and
# the underlying ``docker.from_env()`` client multiplexes calls safely.
_bridge: HermesBridge | None = None


def _get_bridge() -> HermesBridge:
    global _bridge
    if _bridge is None:
        _bridge = HermesBridge()
    return _bridge


def _reset_bridge() -> None:
    """Test helper — drop the singleton so a fresh fake can take over."""
    global _bridge
    _bridge = None


def _git_sha() -> str:
    """Best-effort short SHA of HEAD, or 'dev' if not in a git checkout."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if result.returncode == 0:
            sha = result.stdout.strip()
            if sha:
                return sha
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        pass
    return os.environ.get("WORKER_VERSION", "dev")


def _hermes_status() -> dict[str, Any]:
    """Return Hermes bridge status, never raising.

    Wraps :meth:`HermesBridge.healthcheck` with an extra belt-and-braces
    try/except so a misconfigured Docker socket can't take down /work/health.
    """
    try:
        return _get_bridge().healthcheck()
    except Exception as exc:  # noqa: BLE001 — surface as dict, not raise
        return {"container": "error", "error": str(exc)}


@router.get("/work/health", dependencies=[Depends(verify_secret)])
def health(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    """Return worker liveness + capability snapshot."""
    uptime = int(time.time() - _PROCESS_STARTED_AT)
    return {
        "ok": True,
        "version": _git_sha(),
        "uptime_seconds": uptime,
        "tailscale_hostname": settings.tailscale_hostname,
        "claude_code_available": shutil.which("claude") is not None,
        "skills_loaded": [],
        "hermes": _hermes_status(),
    }
