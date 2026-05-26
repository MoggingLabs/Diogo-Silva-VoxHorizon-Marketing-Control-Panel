"""Tests for :mod:`voxhorizon_daemon.healthz`.

The endpoint is tiny and pure: build it with closures over a fake state
and assert the status code on each combination.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from voxhorizon_daemon.healthz import HealthzInputs, build_app


def _inputs(
    *,
    startup_ok: bool,
    consumer_status: str,
    heartbeat: float,
    now: float,
    interval: int = 30,
) -> HealthzInputs:
    return HealthzInputs(
        get_startup_ok=lambda: startup_ok,
        get_consumer_status=lambda: consumer_status,
        get_last_consumer_heartbeat=lambda: heartbeat,
        heartbeat_interval_s=interval,
        clock=lambda: now,
    )


def test_healthz_200_when_live_and_fresh():
    inputs = _inputs(
        startup_ok=True, consumer_status="live", heartbeat=100.0, now=110.0
    )
    app = build_app(inputs)
    client = TestClient(app)
    res = client.get("/healthz")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["consumer_status"] == "live"


def test_healthz_503_when_startup_failed():
    inputs = _inputs(
        startup_ok=False, consumer_status="down", heartbeat=100.0, now=110.0
    )
    app = build_app(inputs)
    client = TestClient(app)
    res = client.get("/healthz")
    assert res.status_code == 503
    assert res.json()["ok"] is False


def test_healthz_503_when_consumer_not_live():
    inputs = _inputs(
        startup_ok=True, consumer_status="starting", heartbeat=100.0, now=110.0
    )
    app = build_app(inputs)
    client = TestClient(app)
    res = client.get("/healthz")
    assert res.status_code == 503


def test_healthz_503_when_no_heartbeat_yet():
    inputs = _inputs(
        startup_ok=True, consumer_status="live", heartbeat=0.0, now=10.0
    )
    app = build_app(inputs)
    client = TestClient(app)
    res = client.get("/healthz")
    assert res.status_code == 503


def test_healthz_503_when_heartbeat_stale():
    inputs = _inputs(
        startup_ok=True,
        consumer_status="live",
        heartbeat=100.0,
        # interval=30 means stale_threshold=60; 165s elapsed is > 60s stale
        now=265.0,
        interval=30,
    )
    app = build_app(inputs)
    client = TestClient(app)
    res = client.get("/healthz")
    assert res.status_code == 503
    body = res.json()
    assert body["heartbeat_age_s"] is not None and body["heartbeat_age_s"] > 60


def test_healthz_payload_carries_diagnostics():
    inputs = _inputs(
        startup_ok=True, consumer_status="live", heartbeat=100.0, now=120.0
    )
    app = build_app(inputs)
    client = TestClient(app)
    body = client.get("/healthz").json()
    # Every diagnostic field present
    for key in (
        "ok",
        "startup_ok",
        "consumer_status",
        "heartbeat_age_s",
        "stale_threshold_s",
    ):
        assert key in body
