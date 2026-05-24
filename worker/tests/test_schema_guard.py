"""Tests for the startup applied-migrations handshake (E5.5 / #523).

``schema_guard`` pins the schema floor to a SENTINEL object the latest required
migration creates, and probes it at startup. The migration chain is forward-only
files with no ``schema_migrations`` table, so the presence of that table is the
proof the DB is at/above the required migration. These tests assert:

  * the floor constants stay in lockstep (the sentinel is the table the named
    required migration actually creates -- a real migration file);
  * a present sentinel -> schema current -> :func:`assert_schema_current`
    returns, :func:`check_schema_at_startup` returns ``True``;
  * a missing relation -> :class:`SchemaBehindError` -> the safe wrapper logs
    ``schema_guard_behind`` and returns ``False`` (NEVER raises);
  * an unconfigured / unreachable Supabase is an inconclusive SKIP (returns
    ``False``, no false "behind" verdict), so dev / tests / health-only boots
    are unaffected;
  * the missing-relation classifier matches the real Postgres + PostgREST error
    shapes but NOT an unrelated failure;
  * ``create_app()`` wires the guard in and survives with no Supabase configured.

Driven against the in-memory ``FakeSupabase`` double (conftest), patched onto
the guard's lazily-imported ``get_supabase_admin``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src import supabase_client
from src.services import schema_guard
from src.services.schema_guard import SchemaBehindError
from tests.conftest import FakeSupabase


# tests/test_schema_guard.py -> worker/ -> repo root -> db/migrations
_REPO_ROOT = Path(__file__).resolve().parents[2]
_MIGRATIONS_DIR = _REPO_ROOT / "db" / "migrations"


@pytest.fixture
def fake_guard_sb(monkeypatch: pytest.MonkeyPatch) -> FakeSupabase:
    """Install a FakeSupabase as the admin client the guard resolves.

    The guard imports ``get_supabase_admin`` lazily from ``..supabase_client``,
    so patching it there is what the probe actually picks up.
    """
    sb = FakeSupabase()
    monkeypatch.setattr(supabase_client, "get_supabase_admin", lambda: sb)
    return sb


# ===========================================================================
# Floor constants
# ===========================================================================


def test_required_migration_file_exists() -> None:
    # The floor names a REAL migration file (forward-only chain), so bumping the
    # floor can't silently point at a migration that does not exist.
    path = _MIGRATIONS_DIR / f"{schema_guard.REQUIRED_MIGRATION}.sql"
    assert path.exists(), f"required migration file missing: {path}"


def test_sentinel_table_is_created_by_required_migration() -> None:
    # The sentinel must be a table the required migration creates -- that is the
    # whole proof: table present <=> migration applied. Assert the migration's
    # DDL creates exactly that relation.
    sql = (_MIGRATIONS_DIR / f"{schema_guard.REQUIRED_MIGRATION}.sql").read_text(
        encoding="utf-8"
    )
    assert f"create table if not exists {schema_guard.SENTINEL_TABLE}" in sql.lower()


# ===========================================================================
# assert_schema_current
# ===========================================================================


def test_assert_passes_when_sentinel_present(fake_guard_sb: FakeSupabase) -> None:
    # An empty-but-existing table is enough: the probe proves the relation
    # resolves, never reads rows. FakeSupabase.table(...).select().limit().execute()
    # returns an (empty) result, modelling a present table.
    schema_guard.assert_schema_current()  # must not raise


def test_assert_passes_when_sentinel_has_rows(fake_guard_sb: FakeSupabase) -> None:
    fake_guard_sb.seed(schema_guard.SENTINEL_TABLE, [{"task_id": "t-1"}])
    schema_guard.assert_schema_current()  # must not raise


def test_assert_raises_schema_behind_when_relation_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Model the sentinel table missing (pre-migration): the probe raises a
    # Postgres-style 'relation does not exist'.
    class _MissingTableSupabase(FakeSupabase):
        def table(self, name: str):  # type: ignore[override]
            raise RuntimeError(
                f'relation "{name}" does not exist'
            )

    monkeypatch.setattr(
        supabase_client, "get_supabase_admin", lambda: _MissingTableSupabase()
    )

    with pytest.raises(SchemaBehindError) as ei:
        schema_guard.assert_schema_current()

    # The error is actionable: it names the owed migration + sentinel.
    assert ei.value.required_migration == schema_guard.REQUIRED_MIGRATION
    assert ei.value.sentinel_table == schema_guard.SENTINEL_TABLE
    assert "supabase db push" in str(ei.value)


def test_assert_reraises_inconclusive_error_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A non-relation failure (timeout / auth / network) is NOT a proven schema
    # mismatch: it must propagate as-is, never as SchemaBehindError.
    class _FlakySupabase(FakeSupabase):
        def table(self, name: str):  # type: ignore[override]
            raise RuntimeError("connection timed out")

    monkeypatch.setattr(
        supabase_client, "get_supabase_admin", lambda: _FlakySupabase()
    )

    with pytest.raises(RuntimeError) as ei:
        schema_guard.assert_schema_current()
    assert not isinstance(ei.value, SchemaBehindError)
    assert "timed out" in str(ei.value)


# ===========================================================================
# Missing-relation classifier
# ===========================================================================


@pytest.mark.parametrize(
    "message",
    [
        'relation "video_render_tasks" does not exist',
        "ERROR: 42P01: undefined_table",
        "PGRST205: Could not find the table 'public.video_render_tasks'",
        "Could not find the table in the schema cache",
    ],
)
def test_classifier_matches_missing_relation_shapes(message: str) -> None:
    assert schema_guard._is_missing_relation_error(RuntimeError(message)) is True


@pytest.mark.parametrize(
    "message",
    [
        "connection timed out",
        "permission denied for table video_render_tasks",
        "JWT expired",
        "could not connect to server",
    ],
)
def test_classifier_rejects_unrelated_errors(message: str) -> None:
    assert schema_guard._is_missing_relation_error(RuntimeError(message)) is False


# ===========================================================================
# check_schema_at_startup (best-effort wrapper)
# ===========================================================================


def test_safe_check_returns_true_when_current(fake_guard_sb: FakeSupabase) -> None:
    assert schema_guard.check_schema_at_startup() is True


def test_safe_check_returns_false_and_logs_when_behind(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _MissingTableSupabase(FakeSupabase):
        def table(self, name: str):  # type: ignore[override]
            raise RuntimeError(f'relation "{name}" does not exist')

    monkeypatch.setattr(
        supabase_client, "get_supabase_admin", lambda: _MissingTableSupabase()
    )

    captured: dict[str, object] = {}

    def _capture_error(event: str, **kw: object) -> None:
        captured["event"] = event
        captured.update(kw)

    monkeypatch.setattr(schema_guard.log, "error", _capture_error)

    # A proven mismatch must NOT crash startup -- it returns False after a loud log.
    assert schema_guard.check_schema_at_startup() is False
    assert captured["event"] == "schema_guard_behind"
    assert captured["required_migration"] == schema_guard.REQUIRED_MIGRATION


def test_safe_check_returns_false_when_supabase_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Mirror the no-Supabase boot: the admin client raises on access. The guard
    # must SKIP (return False, no false "behind"), never raise.
    def _boom() -> object:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY must be set")

    monkeypatch.setattr(supabase_client, "get_supabase_admin", _boom)

    assert schema_guard.check_schema_at_startup() is False


def test_safe_check_skips_on_inconclusive_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A transient failure is a quiet skip, not a "behind" verdict.
    class _FlakySupabase(FakeSupabase):
        def table(self, name: str):  # type: ignore[override]
            raise RuntimeError("connection timed out")

    monkeypatch.setattr(
        supabase_client, "get_supabase_admin", lambda: _FlakySupabase()
    )

    skipped: dict[str, object] = {}

    def _capture_warning(event: str, **kw: object) -> None:
        skipped["event"] = event

    monkeypatch.setattr(schema_guard.log, "warning", _capture_warning)

    assert schema_guard.check_schema_at_startup() is False
    assert skipped["event"] == "schema_guard_skipped"


# ===========================================================================
# Startup wiring
# ===========================================================================


def test_create_app_runs_schema_guard_without_crashing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # create_app() must call the guard and survive even when Supabase is
    # unconfigured (the autouse worker_env fixture sets no SUPABASE_* vars).
    called: dict[str, bool] = {"checked": False}

    real_check = schema_guard.check_schema_at_startup

    def _spy() -> bool:
        called["checked"] = True
        return real_check()

    monkeypatch.setattr(schema_guard, "check_schema_at_startup", _spy)

    from src.main import create_app

    app = create_app()
    assert app is not None
    assert called["checked"] is True
