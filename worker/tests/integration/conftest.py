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

import os
from collections.abc import Iterator
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
# tests/integration/conftest.py -> worker/ -> repo root -> db/migrations
_REPO_ROOT = Path(__file__).resolve().parents[3]
_MIGRATIONS_DIR = _REPO_ROOT / "db" / "migrations"


# ---------------------------------------------------------------------------
# Supabase scaffolding a vanilla Postgres lacks (provisioned before migrations).
# ---------------------------------------------------------------------------
# Every object here is something a real migration references but a stock
# Postgres image does not ship. All idempotent so re-applying is a no-op.
_BOOTSTRAP_SQL = """
-- Roles the lockdown migrations (0010 / 0011) and Supabase defaults reference.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  -- 0010 runs `alter default privileges for role postgres ...`; the throwaway
  -- container superuser may not be named "postgres", so make sure it exists.
  if not exists (select 1 from pg_roles where rolname = 'postgres') then
    create role postgres login superuser;
  end if;
end
$$;

-- The realtime publication every user-visible table is added to.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

-- The storage schema + buckets table 0003 inserts into.
create schema if not exists storage;
create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);
"""


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
# Database lifecycle (session-scoped: spin once, migrate once)
# ===========================================================================


@pytest.fixture(scope="session")
def pg_dsn() -> Iterator[str]:
    """Resolve a Postgres DSN, or skip the tier cleanly.

    DATABASE_URL wins (the contract). Otherwise try testcontainers + Docker.
    Otherwise skip -- the unit suite and the coverage gate never see this tier.
    """
    env_url = os.environ.get("DATABASE_URL")
    if env_url:
        yield env_url
        return

    try:
        from testcontainers.postgres import PostgresContainer
    except ImportError:
        pytest.skip(
            "integration tier needs DATABASE_URL, or the `testcontainers` "
            "package + Docker to spin one (neither is available)."
        )
        return

    try:
        container = PostgresContainer("postgres:16-alpine", driver="psycopg")
        container.start()
    except Exception as exc:  # noqa: BLE001 - Docker absent/unreachable -> skip
        pytest.skip(
            f"integration tier could not start a Postgres container "
            f"(set DATABASE_URL to run against an existing DB): {exc}"
        )
        return

    try:
        # testcontainers hands back a SQLAlchemy-style URL; normalise it to a
        # plain libpq DSN psycopg.connect understands.
        url = container.get_connection_url()
        dsn = url.replace("postgresql+psycopg://", "postgresql://").replace(
            "postgresql+psycopg2://", "postgresql://"
        )
        yield dsn
    finally:
        container.stop()


@pytest.fixture(scope="session")
def migrated_db(pg_dsn: str):
    """Apply bootstrap + every db/migrations/*.sql (lexical order) once.

    Yields the live connection (autocommit) with the full rebuild schema in
    place. Skips with a clear message if psycopg is missing or the DB is
    unreachable, so a misconfigured DATABASE_URL degrades to a skip rather than
    a hard error that would mask the unit suite.
    """
    try:
        import psycopg
    except ImportError:  # pragma: no cover - psycopg is a dev dep
        pytest.skip("integration tier needs the `psycopg` package.")

    try:
        conn = psycopg.connect(pg_dsn, autocommit=True)
    except Exception as exc:  # noqa: BLE001 - unreachable DB -> skip, don't error
        pytest.skip(f"integration tier could not connect to Postgres: {exc}")

    migrations = sorted(_MIGRATIONS_DIR.glob("*.sql"))
    if not migrations:
        conn.close()
        pytest.skip(f"no migrations found under {_MIGRATIONS_DIR}")

    try:
        with conn.cursor() as cur:
            cur.execute(_BOOTSTRAP_SQL)
            for path in migrations:
                sql = path.read_text(encoding="utf-8")
                try:
                    cur.execute(sql)
                except Exception as exc:  # noqa: BLE001 - name the failing file
                    raise RuntimeError(
                        f"failed applying migration {path.name}: {exc}"
                    ) from exc
        yield conn
    finally:
        conn.close()


@pytest.fixture
def db_conn(pg_dsn: str, migrated_db) -> Iterator["object"]:
    """A per-test connection wrapped in a rolled-back transaction.

    Depends on ``migrated_db`` so the schema is applied (once, session-scoped)
    before any test connects, then opens its OWN connection on the same DSN.
    Each test runs in one transaction that is rolled back at teardown, so seeded
    rows never leak between tests and a FK violation aborts only its own
    transaction. A separate connection per test keeps the FK-violation tests
    isolated from the long-lived migration connection.
    """
    import psycopg

    conn = psycopg.connect(pg_dsn, autocommit=False)
    try:
        yield conn
    finally:
        conn.rollback()
        conn.close()


# ===========================================================================
# Both-vertical seed fixtures
# ===========================================================================


def _seed_client(cur, *, client_id: str | None = None) -> str:
    """Insert a roofing client and return its id."""
    cur.execute(
        """
        insert into clients (id, slug, name, service_type)
        values (coalesce(%s::uuid, gen_random_uuid()),
                'acme-roofing-' || substr(md5(random()::text), 1, 8),
                'Acme Roofing', 'roofing')
        returning id
        """,
        (client_id,),
    )
    return str(cur.fetchone()[0])


@pytest.fixture
def image_creative(db_conn) -> dict[str, str]:
    """Seed an IMAGE creative via ``briefs`` + ``creatives``.

    Returns ``{client_id, brief_id, pipeline_id, creative_id}``. The creative_id
    is a real ``creatives(id)`` -- so it is the one a gate row legitimately
    references today.
    """
    with db_conn.cursor() as cur:
        client_id = _seed_client(cur)
        # brief_id_human is UNIQUE; make it per-invocation so the fixture is safe
        # to use in several tests regardless of commit/rollback behaviour.
        cur.execute(
            """
            insert into briefs (brief_id_human, client_id, status, payload)
            values ('acme-' || substr(md5(random()::text), 1, 12), %s, 'approved',
                    '{"service": "roofing", "budget": 1000}'::jsonb)
            returning id
            """,
            (client_id,),
        )
        brief_id = str(cur.fetchone()[0])
        cur.execute(
            """
            insert into pipelines (format_choice, client_id, image_brief_id)
            values ('image', %s, %s)
            returning id
            """,
            (client_id, brief_id),
        )
        pipeline_id = str(cur.fetchone()[0])
        cur.execute(
            """
            insert into creatives (brief_id, type, concept, ratio, version, status)
            values (%s, 'image', 'fresh-roof', '1x1', 'v1.0', 'draft')
            returning id
            """,
            (brief_id,),
        )
        creative_id = str(cur.fetchone()[0])
    return {
        "client_id": client_id,
        "brief_id": brief_id,
        "pipeline_id": pipeline_id,
        "creative_id": creative_id,
    }


@pytest.fixture
def video_creative(db_conn) -> dict[str, str]:
    """Seed a VIDEO creative via ``video_briefs`` + ``video_creatives``.

    Returns ``{client_id, brief_id, pipeline_id, creative_id}``. The creative_id
    is a real ``video_creatives(id)`` -- crucially NOT a ``creatives(id)``. Today
    the shared gate / evidence tables FK ``creatives(id)`` only, so this id has
    no valid home in ``creative_stage_state`` / ``compliance_finding`` /
    ``qa_result`` -- which is the foundation bug M1 (#448) fixes.
    """
    with db_conn.cursor() as cur:
        client_id = _seed_client(cur)
        # 0004 CHECK video_briefs_required_when_posted: a non-draft video brief
        # must carry target_duration_s + voice_id. The integration tier (vs. the
        # FK-blind fake double) actually enforces this, so the seed sets them.
        cur.execute(
            """
            insert into video_briefs
              (brief_id_human, client_id, status, target_duration_s, voice_id)
            values ('vid-acme-' || substr(md5(random()::text), 1, 12), %s,
                    'approved', 30, 'voice-1')
            returning id
            """,
            (client_id,),
        )
        brief_id = str(cur.fetchone()[0])
        cur.execute(
            """
            insert into pipelines (format_choice, client_id, video_brief_id)
            values ('video', %s, %s)
            returning id
            """,
            (client_id, brief_id),
        )
        pipeline_id = str(cur.fetchone()[0])
        cur.execute(
            """
            insert into video_creatives (brief_id, version, status)
            values (%s, 1, 'draft')
            returning id
            """,
            (brief_id,),
        )
        creative_id = str(cur.fetchone()[0])
    return {
        "client_id": client_id,
        "brief_id": brief_id,
        "pipeline_id": pipeline_id,
        "creative_id": creative_id,
    }
