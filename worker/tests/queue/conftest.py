"""Postgres-backed fixtures for the work_item queue tests.

These tests live under ``tests/queue/`` (per the PR-1 plan-of-record) but
need the same fixtures the existing E0.1 integration tier provides --
``pg_dsn``, ``migrated_db``, ``db_conn`` -- because the work_item state
machine, the auto-emit trigger, and the cancel-propagation trigger only
exist as live SQL artifacts; the in-memory ``FakeSupabase`` double cannot
exercise them.

The plugin registration that makes those fixtures visible here happens at
the TOP-LEVEL ``tests/conftest.py`` (recent pytest forbids non-top-level
``pytest_plugins`` declarations). This conftest just auto-applies the
``integration`` marker for any test in this directory and relaxes the
coverage floor for an ``-m integration`` selection, mirroring the same
hooks the integration tier's conftest exposes for ITS directory.
"""

from __future__ import annotations

from pathlib import Path

import pytest


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    """Auto-apply the ``integration`` marker to every test under this dir.

    Mirrors the same hook the integration conftest exposes, so a queue test
    is selected by ``uv run pytest -m integration`` without remembering the
    decorator + skipped cleanly when no DB is reachable.
    """
    here = Path(__file__).resolve().parent
    for item in items:
        try:
            in_dir = here in Path(str(item.fspath)).resolve().parents
        except OSError:  # pragma: no cover - defensive on odd paths
            in_dir = False
        if in_dir:
            item.add_marker("integration")


@pytest.hookimpl(trylast=True)
def pytest_configure(config: pytest.Config) -> None:
    """Relax the global coverage floor for an integration-ONLY selection.

    Mirrors the same hook in ``tests/integration/conftest.py``. The default
    ``addopts`` enforces ``--cov-fail-under=90`` over ``src`` so a plain
    ``uv run pytest`` is the line-coverage gate. An ``-m integration`` run
    against the work_item DB tier executes ONLY schema-proving tests, so
    the 90% floor would spuriously fail that command. The dual scopes
    (queue + integration tier) keep the unit gate intact.
    """
    markexpr = str(getattr(config.option, "markexpr", "") or "")
    if markexpr.strip() != "integration":
        return

    config.option.cov_fail_under = 0

    cov_plugin = config.pluginmanager.get_plugin("_cov")
    options = getattr(cov_plugin, "options", None)
    if options is not None and getattr(options, "cov_fail_under", None) is not None:
        options.cov_fail_under = 0
