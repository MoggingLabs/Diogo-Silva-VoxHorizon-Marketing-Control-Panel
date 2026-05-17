"""GET /work/ping — unauthenticated liveness probe.

This is the ONE worker route that intentionally bypasses the shared-secret
bearer dependency. External uptime monitors (Uptime Robot, Healthchecks.io
fallback, etc.) need a stable HTTP target they can poll on a 1- or 5-minute
interval without a rotating bearer token in their config.

The body is deliberately minimal: a single ``{"ok": true}`` literal. No
version string, no env name, no build SHA — anything we leak here is leaked
publicly through Tailscale Funnel / Caddy. Keep it boring.

The authed counterpart for richer status (version, queue depth, capability
flags) lives at ``/work/health``; see ``routes/health.py``.
"""

from __future__ import annotations

from fastapi import APIRouter


router = APIRouter()


@router.get("/work/ping")
def ping() -> dict[str, bool]:
    """Return ``{"ok": true}`` with no auth and no side effects.

    This route MUST NOT depend on :func:`src.auth.verify_secret`. If a
    future change adds global auth middleware, ``/work/ping`` needs an
    explicit exemption — uptime monitors cannot present a bearer.
    """
    return {"ok": True}
