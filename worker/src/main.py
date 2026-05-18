"""FastAPI app entry. Wires routers, CORS, structlog."""

from __future__ import annotations

import logging
import sys

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routes import (
    health,
    hermes_approval,
    hermes_chat,
    hermes_kanban,
    hermes_webhook,
    pipeline,
    ping,
)


def _configure_logging() -> None:
    """Configure structlog to emit JSON to stdout."""
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=logging.INFO,
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def create_app() -> FastAPI:
    """Build the FastAPI application.

    Kept as a factory so tests can override settings or skip side-effecty
    setup (e.g. logging) cleanly.
    """
    _configure_logging()
    settings = get_settings()

    app = FastAPI(
        title="VoxHorizon Worker",
        version="0.1.0",
        description="Local Python worker behind the Next.js marketing control panel.",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.worker_cors_origin],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router, tags=["health"])
    # Public, unauthenticated liveness probe for external uptime monitors
    # (Uptime Robot etc.). MUST stay free of auth dependencies — see
    # routes/ping.py and infra/monitoring/README.md (VPS-6).
    app.include_router(ping.router, tags=["ping"])

    # Empty stub router kept while HI-7 finishes repointing Next.js
    # from /work/pipeline/* onto /work/hermes/*. The router carries no
    # endpoints so a stale dashboard call lands as a clean 404.
    app.include_router(pipeline.router, tags=["pipeline"])

    # === wave 18 hermes-bridge routes ===
    # Three thin surfaces that proxy to the co-located Hermes/Ekko
    # container via docker.sock exec. /work/hermes/chat streams stdout
    # from `hermes chat -q` (HI-2); /work/hermes/kanban wraps the kanban
    # CLI for long-running orchestration (HI-3); /work/hermes/webhook
    # receives shell-hook callbacks from Hermes and fans out to
    # Supabase + VAPID (HI-4).
    app.include_router(hermes_chat.router, tags=["hermes-chat"])
    app.include_router(hermes_kanban.router, tags=["hermes-kanban"])
    app.include_router(hermes_webhook.router, tags=["hermes-webhook"])

    # === wave 19 dashboard-driven approvals ===
    # /work/hermes/approval is the worker side of the approval long-poll.
    # The Hermes plugin (voxhorizon-approvals, HI-13) POSTs here from
    # inside the Ekko container; this endpoint inserts a pending row,
    # polls Supabase for the operator's decision, and returns the verdict
    # to the plugin so the agent's tool call can proceed or abort.
    # Bearer-authed with VOXHORIZON_APPROVAL_TOKEN (separate from
    # WORKER_SHARED_SECRET — the plugin doesn't share the dashboard's key).
    app.include_router(hermes_approval.router, tags=["hermes-approval"])

    structlog.get_logger(__name__).info(
        "worker_started",
        tailscale_hostname=settings.tailscale_hostname,
        broll_backend=settings.broll_store_backend,
    )

    return app


app = create_app()
