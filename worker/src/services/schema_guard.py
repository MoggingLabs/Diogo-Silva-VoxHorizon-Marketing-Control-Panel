"""Startup applied-migrations handshake (E5.5 / #523).

THE PROBLEM. ``deploy-stack.yml`` applies NO migrations: schema is pushed
manually via ``supabase db push``, decoupled from the code deploy. So a rolled
image can boot against a DB that is BEHIND the schema the code expects (the push
was forgotten, or ran against the wrong project), and the mismatch surfaces only
later as a cryptic ``relation ... does not exist`` / ``column ... does not exist``
deep inside a request -- after the worker has already reported healthy and taken
traffic. There is no startup guard and no applied-migrations table to consult.

THE HANDSHAKE. The migration chain in ``db/migrations`` is forward-only file
migrations (``0001..N``) with no ``schema_migrations`` marker table. Rather than
introduce one (which would itself need a migration applied to the live
multi-tenant DB before it could be read -- a chicken-and-egg), we pin the schema
floor to a SENTINEL OBJECT: the most recent migration the code requires creates a
known table, and the presence of that table is proof the DB is at-or-past that
migration. At startup the guard does one cheap, bounded probe (``select ...
limit 1``) for the sentinel:

  * probe succeeds            -> schema is at/above the required floor  -> OK;
  * relation does not exist   -> schema is BEHIND the code              -> loud
                                 warn (a forgotten / failed ``supabase db push``);
  * Supabase unconfigured     -> dev / tests / health-only boot         -> SKIP.

To bump the floor when a new migration lands, update ``REQUIRED_MIGRATION`` +
``SENTINEL_TABLE`` together (the table the new migration introduces). The
deploy-path gate in ``.github/workflows/deploy-stack.yml`` probes the SAME
sentinel via the Supabase REST API (the same admin credentials this guard uses)
BEFORE rolling images, so a behind DB fails the deploy instead of shipping a
broken image. See ``docs/migrations.md`` for the expand/contract
rule and ``docs/runbooks/rollback.md`` for the rollback contract.

DESIGN. ``assert_schema_current`` raises :class:`SchemaBehindError` on a proven
mismatch and is the testable core. ``check_schema_at_startup`` is the
best-effort wrapper ``create_app()`` wires in: it NEVER raises (an unconfigured
or unreachable Supabase just logs and returns), mirroring
``seed_compliance_rules_safe`` -- startup must not crash when Supabase is absent
in dev. The worker still boots (health + local b-roll work without a DB); the
loud ``schema_guard_behind`` log is the operator's signal that a ``db push`` is
owed.
"""

from __future__ import annotations

import structlog


log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Schema floor: the latest migration the code requires + its sentinel object.
# ---------------------------------------------------------------------------
# Keep these two in lockstep when a new migration lands: REQUIRED_MIGRATION is
# the file name (sans .sql) of the newest migration the worker's code depends on,
# and SENTINEL_TABLE is a table that migration creates. The deploy gate in
# deploy-stack.yml hardcodes the SAME table name, so the in-app probe and the
# pre-deploy probe agree by construction.
REQUIRED_MIGRATION = "0034_creative_identity_base"
SENTINEL_TABLE = "creative"


class SchemaBehindError(RuntimeError):
    """The live DB schema is provably BEHIND the version the code requires.

    Raised by :func:`assert_schema_current` when the sentinel object is missing
    (the migration the code requires has not been applied). Carries the required
    migration + sentinel table so the message is actionable (run the owed
    ``supabase db push``).
    """

    def __init__(self, required_migration: str, sentinel_table: str) -> None:
        self.required_migration = required_migration
        self.sentinel_table = sentinel_table
        super().__init__(
            f"DB schema is behind code: required migration "
            f"{required_migration!r} not applied (sentinel table "
            f"{sentinel_table!r} is missing). Run `supabase db push`."
        )


def _is_missing_relation_error(exc: Exception) -> bool:
    """True when ``exc`` looks like a 'relation/table does not exist' error.

    The sentinel probe distinguishes the one outcome that PROVES the schema is
    behind (the table is missing) from every other failure (network blip, auth,
    timeout) which is inconclusive and must NOT be reported as a schema mismatch.
    Postgres raises ``UndefinedTable`` (SQLSTATE 42P01); supabase-py / PostgREST
    surface it as ``PGRST205`` ("Could not find the table ... in the schema
    cache") or a message containing "does not exist". We match on the stable
    substrings rather than an exception type so both the live PostgREST client
    and a raw psycopg path are covered.
    """
    text = str(exc).lower()
    needles = (
        "does not exist",  # Postgres: relation "x" does not exist
        "42p01",  # Postgres SQLSTATE UndefinedTable
        "pgrst205",  # PostgREST: table not found in schema cache
        "could not find the table",  # PostgREST human message
    )
    return any(n in text for n in needles)


def assert_schema_current() -> None:
    """Probe the sentinel object; raise if the schema is behind the code.

    Resolves the service-role admin client and issues one bounded
    ``select ... limit 1`` against :data:`SENTINEL_TABLE`. A successful probe (or
    an empty result) means the table exists, so the schema is at/above
    :data:`REQUIRED_MIGRATION`. A 'relation does not exist' error PROVES the
    schema is behind and raises :class:`SchemaBehindError`.

    Re-raises:

      * :class:`SchemaBehindError` when the sentinel is proven missing;
      * the underlying error for any OTHER failure (Supabase unconfigured -> the
        admin client's ``RuntimeError``; a network/auth blip), which the safe
        wrapper turns into a non-fatal SKIP -- an inconclusive probe must never
        masquerade as a confirmed mismatch.
    """
    # Imported lazily so importing this module never forces a Supabase client
    # (mirrors compliance_rules_seed: the admin client raises lazily when unset).
    from ..supabase_client import get_supabase_admin

    sb = get_supabase_admin()
    try:
        # limit(1) keeps the probe O(1): we never read rows, only prove the
        # relation resolves. select("*") avoids assuming any particular column.
        sb.table(SENTINEL_TABLE).select("*").limit(1).execute()
    except Exception as exc:  # noqa: BLE001 - classify, then re-raise precisely
        if _is_missing_relation_error(exc):
            raise SchemaBehindError(REQUIRED_MIGRATION, SENTINEL_TABLE) from exc
        # Any other failure is inconclusive (not a proven schema mismatch); let
        # the caller decide. The safe wrapper treats it as a skip.
        raise

    log.info(
        "schema_guard_ok",
        required_migration=REQUIRED_MIGRATION,
        sentinel_table=SENTINEL_TABLE,
    )


def check_schema_at_startup() -> bool:
    """Best-effort :func:`assert_schema_current` for app startup.

    NEVER raises -- a proven mismatch is logged LOUDLY (``schema_guard_behind``,
    error level) but does not crash ``create_app()``, and an unconfigured /
    unreachable Supabase is a quiet SKIP (``schema_guard_skipped``). The worker
    keeps booting either way (health + local b-roll do not need the DB); the loud
    log is the operator's signal that a ``supabase db push`` is owed.

    Returns ``True`` when the schema is confirmed current, ``False`` otherwise
    (behind, or could-not-verify). The boolean is for tests / callers that want
    the verdict; startup itself just relies on the side-effecting log.
    """
    try:
        assert_schema_current()
        return True
    except SchemaBehindError as exc:
        # The one outcome we want LOUD: code expects schema the DB lacks. This is
        # a deploy/migration ordering bug -- a forgotten or failed `db push`.
        log.error(
            "schema_guard_behind",
            required_migration=exc.required_migration,
            sentinel_table=exc.sentinel_table,
            error=str(exc),
        )
        return False
    except Exception as exc:  # noqa: BLE001 - startup must never crash on probe
        # Inconclusive: Supabase unconfigured (dev/tests), or a transient blip.
        # Skip quietly, exactly like the worker booting without the admin client.
        log.warning("schema_guard_skipped", error=str(exc))
        return False
