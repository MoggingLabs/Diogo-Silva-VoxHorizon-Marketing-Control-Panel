"""FastAPI app entry. Wires routers, CORS, structlog."""

from __future__ import annotations

import logging
import sys

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routes import (
    audit,
    broll,
    chat,
    chat_stream,
    creative,
    health,
    launch,
    pipeline,
    ping,
    upload,
    video,
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
    app.include_router(creative.router, tags=["creative"])
    app.include_router(upload.router, tags=["upload"])
    app.include_router(chat.router, tags=["chat"])
    app.include_router(broll.router, tags=["broll"])

    # === wave 4 launch routes ===
    # The /work/upload/drive + /work/video/upload-drive endpoints live on
    # the existing `upload` router (registered above); `launch.router` adds
    # the validator endpoint /work/launch/validate.
    app.include_router(launch.router, tags=["launch"])

    # === wave 5 video routes ===
    # Multi-stage video creative pipeline: script → voiceover → broll
    # search/select → compose → caption. Every route serializes per
    # video_brief_id via the same BriefQueue used by the image stages
    # (V2-16: queue is keyed generically on brief_id so video + image
    # share the singleton without conflict).
    app.include_router(video.router, tags=["video"])

    # === wave 5 audit routes ===
    # /work/audit/run pulls Meta + GHL for image campaigns (M4-1) and
    # /work/audit/video does the same with video-specific Meta fields
    # (M4-13). Both join, compute verdicts, persist, and emit kill
    # notifications through the shared services.
    app.include_router(audit.router, tags=["audit"])

    # === wave 5 chat routes ===
    # SSE streaming endpoints for chat-with-Ekko (image + video). Lives on
    # its own router so the chat.py placeholder for non-streaming agent
    # work can evolve independently.
    app.include_router(chat_stream.router, tags=["chat-stream"])

    # === wave 10 pipeline routes ===
    # /work/pipeline/config-draft streams Ekko's brief-strategist
    # interview for the Configuration stage (PF-B). Future waves add
    # /work/pipeline/ideation and /work/pipeline/generation.
    app.include_router(pipeline.router, tags=["pipeline"])

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
