"""Shared Postgres-backed fixtures (silent-failure PR-1).

Originally defined in ``tests/integration/conftest.py``; promoted to a
plain plugin module so two parallel selections (``tests/integration`` and
``tests/queue``, both ``-m integration``-marked) can share the
session-scoped ``migrated_db`` lifecycle without registering the same
conftest twice (the latter is forbidden by recent pytest because the same
file would resolve to two plugin names).

Registered as a plugin via ``pyproject.toml::tool.pytest.ini_options
::pytest_plugins`` so it loads ONCE per pytest session regardless of how
many subdir conftests reference it.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
# tests/db_fixtures.py -> worker/ -> repo root -> db/migrations
_REPO_ROOT = Path(__file__).resolve().parents[2]
_MIGRATIONS_DIR = _REPO_ROOT / "db" / "migrations"

# Bootstrap (Supabase roles / publication / storage objects a vanilla Postgres
# lacks). Single source of truth (also used by the CI migration-apply job).
_BOOTSTRAP_SQL = (_REPO_ROOT / "db" / "ci-bootstrap.sql").read_text(encoding="utf-8")


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
        url = container.get_connection_url()
        dsn = url.replace("postgresql+psycopg://", "postgresql://").replace(
            "postgresql+psycopg2://", "postgresql://"
        )
        yield dsn
    finally:
        container.stop()


@pytest.fixture(scope="session")
def migrated_db(pg_dsn: str):
    """Apply bootstrap + every db/migrations/*.sql (lexical order) once."""
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
    """A per-test connection wrapped in a rolled-back transaction."""
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
    """Seed an IMAGE creative via ``briefs`` + ``creatives``."""
    with db_conn.cursor() as cur:
        client_id = _seed_client(cur)
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
    """Seed a VIDEO creative via ``video_briefs`` + ``video_creatives``."""
    with db_conn.cursor() as cur:
        client_id = _seed_client(cur)
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
