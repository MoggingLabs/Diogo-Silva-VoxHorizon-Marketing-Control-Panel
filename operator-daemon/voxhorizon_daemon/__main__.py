"""``python -m voxhorizon_daemon`` entry point.

Wires the pieces together:

1. Configure structlog (JSON to stdout) — matches the worker so deploy-stack's
   log scrapers parse both services the same way.
2. Load settings.
3. Construct :class:`QueueClient` + :class:`HermesExec`.
4. Start the :func:`healthz.build_app` server on :9001 as a background task.
5. Construct :class:`Daemon` and ``await daemon.run()``.
6. Install SIGTERM / SIGINT handlers that call ``daemon.request_stop()``.

The whole entry is intentionally short. The orchestration sits in
:class:`Daemon`; this file is the wiring.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys
from typing import Any

import structlog
import uvicorn

from .daemon import Daemon
from .healthz import HealthzInputs, build_app
from .hermes_exec import HermesExec
from .queue_client import QueueClient
from .settings import Settings, get_settings


def _configure_logging() -> None:
    """Configure structlog (JSON to stdout). Matches the worker."""
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


def _build_healthz_inputs(daemon: Daemon, heartbeat_interval_s: int) -> HealthzInputs:
    """Construct healthz inputs bound to the daemon's state. Pulled into its
    own helper so tests cover the lambda capture without exercising uvicorn."""
    return HealthzInputs(
        get_startup_ok=lambda: (
            daemon.state.startup_check is not None
            and daemon.state.startup_check.all_ok
        ),
        get_consumer_status=lambda: daemon.state.consumer_status,
        get_last_consumer_heartbeat=lambda: daemon.state.last_consumer_heartbeat,
        heartbeat_interval_s=heartbeat_interval_s,
    )


async def _serve_healthz(daemon: Daemon, settings: Settings) -> None:  # pragma: no cover - thin uvicorn wrapper
    """Run the FastAPI /healthz server as a background task.

    Bound to :class:`Daemon.state` via lambdas so it always reads the latest
    values. Marked no-cover because the only logic is uvicorn wiring; the
    lambdas it depends on are covered by :func:`_build_healthz_inputs` tests.
    """
    inputs = _build_healthz_inputs(daemon, settings.consumer_heartbeat_s)
    app = build_app(inputs)
    config = uvicorn.Config(
        app,
        host="0.0.0.0",  # noqa: S104 — sidecar bound to its own port
        port=settings.healthz_port,
        log_level="warning",
        access_log=False,
        lifespan="off",
    )
    server = uvicorn.Server(config)
    await server.serve()


async def _amain() -> int:  # pragma: no cover - exercised end-to-end only in production
    """Async entrypoint; constructed for clean test interop.

    The function is the wiring that ties QueueClient + HermesExec + Daemon
    together and runs them under uvicorn's healthz server. Each constituent
    is covered by its own unit tests; this top-level orchestration is hard
    to unit-test cleanly (it spawns uvicorn) and adds no logic of its own.
    """
    settings = get_settings()
    log = structlog.get_logger(__name__)
    log.info(
        "operator_daemon_booting",
        consumer_id=settings.consumer_id,
        worker_url=settings.worker_url,
        hermes_container=settings.hermes_container_name,
    )

    async with QueueClient(
        base_url=settings.worker_url, secret=settings.worker_shared_secret
    ) as queue_client:
        queue_client.set_consumer_id(settings.consumer_id)

        hermes_exec = HermesExec(
            container_name=settings.hermes_container_name,
            hermes_data_dir=settings.hermes_data_dir,
        )

        daemon = Daemon(
            settings=settings,
            queue_client=queue_client,
            hermes_exec=hermes_exec,
        )

        _install_signal_handlers(daemon)

        healthz_task = asyncio.create_task(
            _serve_healthz(daemon, settings), name="healthz"
        )
        try:
            exit_code = await daemon.run()
        finally:
            healthz_task.cancel()
            try:
                await healthz_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

        log.info("operator_daemon_exited", exit_code=exit_code)
        return exit_code


def _install_signal_handlers(daemon: Daemon) -> None:
    """Wire SIGTERM + SIGINT to ``daemon.request_stop()``.

    Windows lacks ``add_signal_handler`` on ProactorEventLoop, so this is a
    best-effort path: production runs on Linux (the sidecar container) where
    both signals are available; local Windows dev presses Ctrl+C and the
    KeyboardInterrupt path catches us anyway.
    """
    loop = asyncio.get_event_loop()
    for sig in (getattr(signal, "SIGTERM", None), getattr(signal, "SIGINT", None)):
        if sig is None:  # pragma: no cover - only stripped Pythons lack these
            continue
        try:
            loop.add_signal_handler(sig, daemon.request_stop)
        except (NotImplementedError, RuntimeError):
            # Windows or already-running tests — fall back to whatever the
            # outer harness does (KeyboardInterrupt, etc.).
            continue


def main() -> int:  # pragma: no cover - sync wrapper around _amain
    """Sync entry called by ``python -m voxhorizon_daemon``."""
    _configure_logging()
    try:
        return asyncio.run(_amain())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":  # pragma: no cover — direct-invocation hook
    raise SystemExit(main())
