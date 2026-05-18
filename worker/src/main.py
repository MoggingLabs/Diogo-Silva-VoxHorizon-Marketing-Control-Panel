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
    hermes_chat,
    hermes_kanban,
    hermes_webhook,
    pipeline,
    ping,
)
from .services.queue import get_queue


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

    # === wave 10 pipeline routes ===
    # /work/pipeline/config-draft streams Ekko's brief-strategist
    # interview for the Configuration stage (PF-B). Future waves add
    # /work/pipeline/ideation and /work/pipeline/generation.
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

    # Eagerly construct the per-brief queue singleton so the first
    # `/work/creative/*` request doesn't race on lazy init.
    get_queue()

    structlog.get_logger(__name__).info(
        "worker_started",
        tailscale_hostname=settings.tailscale_hostname,
        broll_backend=settings.broll_store_backend,
    )

    return app


app = create_app()
