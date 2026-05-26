"""Tiny FastAPI sidecar exposing ``/healthz`` on :9001.

The Docker healthcheck calls this; ``200`` keeps the container marked
healthy, anything else (or a connection refused) flips it to unhealthy.

The endpoint returns 200 iff:

* the startup self-test passed AND
* the most recent consumer heartbeat is no older than ``2 *
  consumer_heartbeat_s`` seconds.

The endpoint deliberately does NOT take dependencies on the worker REST
surface; if the worker is down, the daemon's drain loop has already
swallowed the resulting QueueServerError and the consumer heartbeat will
stop bumping, so the healthcheck flips red on its own. That keeps
``/healthz`` cheap (sub-millisecond when the daemon is healthy) and
isolated from the upstream we're observing.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import FastAPI, Response


@dataclass
class HealthzInputs:
    """The state the endpoint reads. Closes over the daemon's state.

    ``clock`` is injectable for tests; production passes :func:`time.monotonic`.
    ``heartbeat_interval_s`` mirrors :class:`Settings.consumer_heartbeat_s`.
    """

    get_startup_ok: Callable[[], bool]
    get_consumer_status: Callable[[], str]
    get_last_consumer_heartbeat: Callable[[], float]
    heartbeat_interval_s: int
    clock: Callable[[], float] = time.monotonic


def build_app(inputs: HealthzInputs) -> FastAPI:
    """Build a FastAPI app with a single ``/healthz`` route.

    Returns a NEW app per call so tests can spin up isolated instances
    without singleton state.
    """
    app = FastAPI(title="voxhorizon-operator-daemon-healthz", version="0.1.0")

    @app.get("/healthz")
    def healthz() -> Response:
        startup_ok = inputs.get_startup_ok()
        consumer_status = inputs.get_consumer_status()
        last_hb = inputs.get_last_consumer_heartbeat()
        now = inputs.clock()
        age = now - last_hb if last_hb > 0 else None
        # Two-beat stale threshold (mirrors the dashboard's derived staleness).
        stale_threshold = inputs.heartbeat_interval_s * 2

        payload: dict[str, Any] = {
            "ok": False,
            "startup_ok": startup_ok,
            "consumer_status": consumer_status,
            "heartbeat_age_s": age,
            "stale_threshold_s": stale_threshold,
        }

        if not startup_ok:
            return _json_response(payload, status=503)
        if consumer_status != "live":
            return _json_response(payload, status=503)
        if last_hb <= 0:
            # We have not produced a single heartbeat yet (just-started case).
            # Give the daemon one full interval to make its first beat before
            # we flip red.
            return _json_response(payload, status=503)
        if age is not None and age > stale_threshold:
            return _json_response(payload, status=503)

        payload["ok"] = True
        return _json_response(payload, status=200)

    return app


def _json_response(payload: dict[str, Any], *, status: int) -> Response:
    """Hand-rolled JSON response so we keep zero extra dependencies."""
    import json as _json

    return Response(
        content=_json.dumps(payload),
        media_type="application/json",
        status_code=status,
    )


__all__ = ["HealthzInputs", "build_app"]
