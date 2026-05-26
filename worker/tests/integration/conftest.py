"""Postgres-backed integration-tier fixtures (E0.1 / #421).

This is the safety net that must exist BEFORE the M1 schema migration (#448):
the unit suite drives the in-memory ``FakeSupabase`` double from the top-level
``tests/conftest.py``, which silently ignores FK / CHECK / trigger / enum
constraints. That blind spot is exactly how the video FK break shipped
undetected -- ``creative_stage_state`` / ``compliance_finding`` / ``qa_result``
reference ``creatives(id)`` only, so a VIDEO creative (which lives in
``video_creatives``) can never own a gate row, but the fake double happily
"persists" it.

This tier closes the gap by applying the REAL ``db/migrations/*.sql`` (lexical
order) to an ephemeral Postgres and asserting against live constraints.

Database resolution (the DATABASE_URL-skip path is the contract):

  1. ``DATABASE_URL`` env var      -> use it as-is (CI / a dev with a DB);
  2. else ``testcontainers`` + Docker -> spin a throwaway ``postgres:16``;
  3. else                          -> ``pytest.skip`` the whole tier cleanly.

So the normal unit suite + the 90% coverage gate are entirely unaffected: with
no DB reachable, every integration test skips and contributes nothing.

The real migrations target Supabase, so a handful of statements reference
objects a vanilla Postgres lacks (the ``supabase_realtime`` publication, the
``storage`` schema/``buckets`` table, and the ``anon`` / ``authenticated`` /
``service_role`` roles). ``_BOOTSTRAP_SQL`` provisions just those, idempotently,
before the migrations run -- it adds no application schema, only the Supabase
scaffolding the DDL leans on.
"""

from __future__ import annotations

from pathlib import Path

import pytest

# The fixtures (``pg_dsn`` / ``migrated_db`` / ``db_conn`` /
# ``image_creative`` / ``video_creative``) now live in
# ``worker/tests/db_fixtures.py`` and are registered as a pytest plugin via
# ``pyproject.toml``. Existing tests resolve them by name through pytest's
# fixture lookup -- no source change here.


# ===========================================================================
# pytest hooks: auto-mark the tier + relax the cov gate for -m integration runs
# ===========================================================================


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Auto-apply the ``integration`` marker to everything under this dir.

    So a test author drops a file in ``tests/integration/`` and it is selected
    by ``uv run pytest -m integration`` without remembering the decorator.
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

    The default ``addopts`` enforces ``--cov-fail-under=90`` over ``src`` so a
    plain ``uv run pytest`` is the line-coverage gate. An ``-m integration`` run
    executes only this DB tier (which exists to prove constraints, not to cover
    application lines), so the 90% floor would spuriously fail that command. When
    the marker expression selects integration and nothing else, drop the floor to
    0 -- the default run keeps the real gate intact.

    pytest-cov reads the threshold from the ``_cov`` plugin's own options
    namespace (a copy of the parsed args), not from ``config.option``, so the
    floor is cleared on BOTH: the plugin's namespace (controls the exit code) and
    ``config.option`` (belt-and-braces for any other reader).
    """
    markexpr = str(getattr(config.option, "markexpr", "") or "")
    if markexpr.strip() != "integration":
        return

    config.option.cov_fail_under = 0

    cov_plugin = config.pluginmanager.get_plugin("_cov")
    options = getattr(cov_plugin, "options", None)
    if options is not None and getattr(options, "cov_fail_under", None) is not None:
        options.cov_fail_under = 0


# ===========================================================================
# Database lifecycle + seed fixtures
# ===========================================================================
#
# Silent-failure PR-1: the Postgres lifecycle fixtures (``pg_dsn`` /
# ``migrated_db`` / ``db_conn``) + the both-vertical seed fixtures
# (``image_creative`` / ``video_creative``) were promoted to
# ``tests/db_fixtures.py`` so the work_item queue tests under ``tests/queue/``
# (also ``-m integration``-marked) can SHARE them in the same pytest session
# without registering the integration conftest twice (which fails with
# "Plugin already registered under a different name"). The plugin is wired
# via ``pyproject.toml::tool.pytest.ini_options::pytest_plugins``, so this
# directory's tests still see every fixture by name -- the rename is
# transparent to the existing tests.
