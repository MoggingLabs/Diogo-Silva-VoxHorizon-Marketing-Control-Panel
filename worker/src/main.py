"""FastAPI app entry. Wires routers, CORS, structlog."""

from __future__ import annotations

import logging
import sys

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routes import audit, broll, chat, creative, health, launch, upload
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
    app.include_router(creative.router, tags=["creative"])
    app.include_router(audit.router, tags=["audit"])
    app.include_router(upload.router, tags=["upload"])
    app.include_router(chat.router, tags=["chat"])
    app.include_router(broll.router, tags=["broll"])

    # === wave 4 launch routes ===
    # The /work/upload/drive + /work/video/upload-drive endpoints live on
    # the existing `upload` router (registered above); `launch.router` adds
    # the validator endpoint /work/launch/validate.
    app.include_router(launch.router, tags=["launch"])

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
