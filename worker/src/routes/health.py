"""GET /work/health — liveness + capability probe.

Authed like everything else. Returns enough information for the Next.js
side to render a "worker status" panel without making a separate round-trip.
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


router = APIRouter()

_PROCESS_STARTED_AT = time.time()


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
        "queue_depth": {"image": 0, "video": 0, "broll": 0},
    }
