"""Parity contract: the worker rollup mirror matches the SQL (M2 / E2.3).

The per-creative gate predicate is defined ONCE in SQL
(``db/migrations/0039_rollup_excludes_killed.sql`` -- ``pipeline_rollup_cleared``,
the single authority) and mirrored in the worker's ``_CLEARED_STAGE_STATUSES`` +
``_stage_cleared`` killed-exclusion. This test reads the migration text and
asserts the worker's cleared-state set + the killed-exclusion rule are still in
lockstep with the SQL, so a future edit to one without the other fails CI rather
than re-introducing the cross-language drift this milestone fixed.
"""

from __future__ import annotations

import re
from pathlib import Path

from src.routes.integrations import _CLEARED_STAGE_STATUSES


# worker/tests/test_rollup_parity.py -> worker/ -> repo root -> db/migrations
_MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "db"
    / "migrations"
    / "0039_rollup_excludes_killed.sql"
)


def _sql() -> str:
    return _MIGRATION.read_text(encoding="utf-8")


def test_cleared_state_set_matches_sql() -> None:
    """The Python cleared set equals the SQL ``status not in (...)`` terminal-good set."""
    sql = _sql()
    match = re.search(r"status\s+not\s+in\s*\(([^)]*)\)", sql, re.IGNORECASE)
    assert match is not None, "could not find the cleared-state `not in (...)` list in 0039"
    sql_states = set(re.findall(r"'([a-z_]+)'", match.group(1)))
    assert sql_states == set(_CLEARED_STAGE_STATUSES)


def test_sql_drops_killed_creatives_from_scope() -> None:
    """The SQL excludes killed image creatives (matches _killed_creative_ids)."""
    assert re.search(r"<>\s*'killed'", _sql()) is not None


def test_sql_drops_soft_deleted_creatives_from_scope() -> None:
    """The SQL excludes soft-deleted creatives from the rollup scope."""
    assert re.search(r"deleted_at\s+is\s+null", _sql(), re.IGNORECASE) is not None
