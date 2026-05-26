"""Smoke tests for :mod:`voxhorizon_daemon.__main__` and :mod:`settings`.

We do NOT run ``main()`` end-to-end — it would block on the
healthz / drain loops. Instead we cover the configuration + signal-
handler installation paths so the module is exercised at the import
level and the small wiring helpers are tested.
"""

from __future__ import annotations

import asyncio
import os

import pytest

from voxhorizon_daemon import __main__ as main_mod
from voxhorizon_daemon import __version__
from voxhorizon_daemon.daemon import Daemon
from voxhorizon_daemon.hermes_exec import HermesExec
from voxhorizon_daemon.queue_client import QueueClient
from voxhorizon_daemon.settings import Settings, get_settings


def test_version_present():
    assert __version__ == "0.1.0"


def test_configure_logging_idempotent():
    # Multiple calls must not raise (structlog allows reconfig).
    main_mod._configure_logging()
    main_mod._configure_logging()


def test_install_signal_handlers_safe_under_test_loop():
    """Installing the handlers must not raise even when the platform/loop
    does not support :func:`loop.add_signal_handler` (e.g. Windows or the
    pytest-asyncio default loop on some hosts)."""

    async def _go():
        settings = Settings(  # type: ignore[call-arg]
            worker_url="http://x",
            worker_shared_secret="y",
            consumer_id="z",
        )
        qc = QueueClient(base_url=settings.worker_url, secret=settings.worker_shared_secret)
        hx = HermesExec(container_name="hermes-agent-operator", client=object())  # type: ignore[arg-type]
        daemon = Daemon(settings=settings, queue_client=qc, hermes_exec=hx)
        main_mod._install_signal_handlers(daemon)
        # Daemon must still be stoppable after the install pass.
        daemon.request_stop()
        assert daemon._stop_event.is_set()  # type: ignore[attr-defined]

    asyncio.get_event_loop_policy().new_event_loop().run_until_complete(_go())


def test_settings_required_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("WORKER_URL", "http://w.example")
    monkeypatch.setenv("WORKER_SHARED_SECRET", "shh")
    get_settings.cache_clear()
    s = get_settings()
    assert s.worker_url == "http://w.example"
    assert s.worker_shared_secret == "shh"
    # Defaults are stable
    assert s.consumer_id.startswith("operator-daemon")
    assert s.consumer_heartbeat_s >= 1
    get_settings.cache_clear()


def test_build_healthz_inputs_reads_daemon_state():
    """The lambdas inside HealthzInputs MUST read live state, not snapshot it."""

    settings = Settings(  # type: ignore[call-arg]
        worker_url="http://x",
        worker_shared_secret="y",
        consumer_id="z",
        consumer_heartbeat_s=15,
    )
    qc = QueueClient(base_url=settings.worker_url, secret=settings.worker_shared_secret)
    hx = HermesExec(container_name="hermes-agent-operator", client=object())  # type: ignore[arg-type]
    daemon = Daemon(settings=settings, queue_client=qc, hermes_exec=hx)

    inputs = main_mod._build_healthz_inputs(daemon, settings.consumer_heartbeat_s)

    # Initially the daemon has no startup check + status=starting
    assert inputs.get_startup_ok() is False
    assert inputs.get_consumer_status() == "starting"
    assert inputs.get_last_consumer_heartbeat() == 0.0

    # Flipping daemon state must be visible through the lambdas
    from voxhorizon_daemon.types import StartupCheck, StartupCheckEntry

    daemon.state.startup_check = StartupCheck(
        queue_reachable=StartupCheckEntry(ok=True),
        hermes_container_up=StartupCheckEntry(ok=True),
        hermes_auth=StartupCheckEntry(ok=True),
    )
    daemon.state.consumer_status = "live"
    daemon.state.last_consumer_heartbeat = 42.0

    assert inputs.get_startup_ok() is True
    assert inputs.get_consumer_status() == "live"
    assert inputs.get_last_consumer_heartbeat() == 42.0
    assert inputs.heartbeat_interval_s == 15


def test_settings_missing_required_raises(monkeypatch: pytest.MonkeyPatch):
    # Clear both required vars; pydantic-settings raises ValidationError
    monkeypatch.delenv("WORKER_URL", raising=False)
    monkeypatch.delenv("WORKER_SHARED_SECRET", raising=False)
    get_settings.cache_clear()
    try:
        with pytest.raises(Exception):
            get_settings()
    finally:
        get_settings.cache_clear()
