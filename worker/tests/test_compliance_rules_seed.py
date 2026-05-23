"""Tests for the compliance_rule lookup seeder (#394).

The seeder mirrors the in-memory ruleset (the single source of truth) into the
``compliance_rule`` lookup table via an idempotent UPSERT. These tests assert:

  * every ``get_starter_rules()`` row is UPSERTed (one DB row per rule);
  * a second call is a no-op (idempotent — no duplicate inserts);
  * the engine -> DB projection is faithful (severity enum, derived authority,
    text version);
  * the startup-safe wrapper NEVER raises (a broken / unreachable DB just logs
    and skips), so it can be a best-effort ``create_app()`` side-effect.

Driven against the in-memory ``FakeSupabase`` double (conftest), patched onto
the seed module's lazily-imported ``get_supabase_admin``. The worker can't run
on the dev Windows host (pyiceberg/MSVC); these are written to be correct and
validated in CI.
"""

from __future__ import annotations

import pytest

from src import supabase_client
from src.services import compliance_rules_seed as seed_mod
from src.services.compliance_rules import get_starter_rules, rule_count
from tests.conftest import FakeSupabase


@pytest.fixture
def fake_seed_sb(monkeypatch: pytest.MonkeyPatch) -> FakeSupabase:
    """Install a FakeSupabase as the admin client the seeder resolves.

    The seeder imports ``get_supabase_admin`` lazily from ``..supabase_client``,
    so patching it there is what the seed call actually picks up.
    """
    sb = FakeSupabase()
    monkeypatch.setattr(supabase_client, "get_supabase_admin", lambda: sb)
    return sb


# ===========================================================================
# Projection
# ===========================================================================


def test_authority_is_derived_from_rule_id_prefix() -> None:
    assert seed_mod._authority_for("meta.personal_attributes") == "meta"
    assert seed_mod._authority_for("ftc.substantiation") == "ftc"
    assert seed_mod._authority_for("google.overlay_text") == "google"
    assert seed_mod._authority_for("client.do_not_say.0") == "client"
    # vertical.* rules are Meta policy substance -> meta authority.
    assert seed_mod._authority_for("vertical.before_after") == "meta"
    # Unknown prefix falls back conservatively to meta (never NULL — the column
    # is NOT NULL).
    assert seed_mod._authority_for("weird.thing") == "meta"


def test_row_projection_maps_severity_and_keeps_text_version() -> None:
    block_rule = next(
        r for r in get_starter_rules() if r["severity"] == "block"
    )
    row = seed_mod._row_for(block_rule)
    # Engine 'block' -> DB 'critical'; matches the route's finding mapping.
    assert row["severity"] == "critical"
    # Version stays the engine's semantic string.
    assert row["version"] == str(block_rule["version"])
    assert isinstance(row["version"], str)
    assert row["active"] is True
    assert row["citation_url"]  # NOT NULL column always carries a value


def test_severity_mapping_matches_route_mapping() -> None:
    # The seeder must pin the SAME enum the finding-writer pins, so a rule and
    # its findings agree on severity.
    from src.routes.qa_compliance import _COMPLIANCE_SEVERITY_TO_DB

    assert seed_mod._SEVERITY_TO_DB == _COMPLIANCE_SEVERITY_TO_DB


# ===========================================================================
# Seeding + idempotency
# ===========================================================================


def test_seed_upserts_every_starter_rule(fake_seed_sb: FakeSupabase) -> None:
    written = seed_mod.seed_compliance_rules()

    assert written == rule_count()
    rows = fake_seed_sb.rows("compliance_rule")
    assert len(rows) == rule_count()

    seeded_ids = {r["rule_id"] for r in rows}
    expected_ids = {r["rule_id"] for r in get_starter_rules()}
    assert seeded_ids == expected_ids

    # First pass is all inserts (no pre-existing rows to update).
    insert_tables = [name for name, _ in fake_seed_sb.inserts]
    assert insert_tables.count("compliance_rule") == rule_count()
    assert not fake_seed_sb.updates


def test_second_seed_is_a_noop_idempotent(fake_seed_sb: FakeSupabase) -> None:
    first = seed_mod.seed_compliance_rules()
    inserts_after_first = len(fake_seed_sb.inserts)

    second = seed_mod.seed_compliance_rules()

    # Same number of rules touched both times...
    assert first == second == rule_count()
    # ...but the second pass adds NO new rows (it updates in place).
    assert fake_seed_sb.rows("compliance_rule").__len__() == rule_count()
    assert len(fake_seed_sb.inserts) == inserts_after_first
    # The second pass UPDATEs each existing row instead.
    update_tables = [name for name, _ in fake_seed_sb.updates]
    assert update_tables.count("compliance_rule") == rule_count()


def test_seed_round_trips_rule_id_and_version(fake_seed_sb: FakeSupabase) -> None:
    seed_mod.seed_compliance_rules()
    rows = {(r["rule_id"], r["version"]): r for r in fake_seed_sb.rows("compliance_rule")}
    for rule in get_starter_rules():
        key = (rule["rule_id"], str(rule["version"]))
        assert key in rows, f"{key} not seeded"
        assert rows[key]["title"] == rule["title"]
        assert rows[key]["citation_url"] == rule["citation_url"]


# ===========================================================================
# Startup safety
# ===========================================================================


def test_safe_seed_returns_count_on_success(fake_seed_sb: FakeSupabase) -> None:
    assert seed_mod.seed_compliance_rules_safe() == rule_count()


def test_safe_seed_never_raises_when_db_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Mirror the no-Supabase boot: the admin client raises on access.
    def _boom() -> object:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY must be set")

    monkeypatch.setattr(supabase_client, "get_supabase_admin", _boom)

    # Must NOT propagate — startup would crash otherwise.
    assert seed_mod.seed_compliance_rules_safe() == 0


def test_safe_seed_never_raises_when_table_insert_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Simulate the table missing (pre-migration) by making insert raise.
    class _BrokenSupabase(FakeSupabase):
        def table(self, name: str):  # type: ignore[override]
            raise RuntimeError(f"relation {name!r} does not exist")

    monkeypatch.setattr(supabase_client, "get_supabase_admin", lambda: _BrokenSupabase())
    assert seed_mod.seed_compliance_rules_safe() == 0


def test_create_app_runs_seed_without_crashing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # create_app() must call the seeder and survive even when Supabase is
    # unconfigured (the autouse worker_env fixture sets no SUPABASE_* vars).
    called: dict[str, bool] = {"seeded": False}

    real_safe = seed_mod.seed_compliance_rules_safe

    def _spy() -> int:
        called["seeded"] = True
        return real_safe()

    monkeypatch.setattr(seed_mod, "seed_compliance_rules_safe", _spy)

    from src.main import create_app

    app = create_app()
    assert app is not None
    assert called["seeded"] is True
