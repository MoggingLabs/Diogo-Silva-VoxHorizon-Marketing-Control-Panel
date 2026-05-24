"""Integration: append-only audit tables are tamper-evident (E6.4 / #532 / 0041).

Proves migration ``0041_audit_append_only_immutability.sql`` against a REAL
Postgres with the actual ``db/migrations/*.sql`` applied: the genuinely
append-only audit / evidence tables let the writer role (``service_role``)
INSERT + SELECT but NOT UPDATE / DELETE, so the same key the agent uses can no
longer rewrite or erase its own history.

Two complementary proofs, because the harness connects as a SUPERUSER (via
``DATABASE_URL`` / testcontainers) and a superuser bypasses GRANTs entirely:

  1. GRANT-level (``information_schema.role_table_grants``): assert the
     service_role privilege set on each table is exactly INSERT + SELECT (no
     UPDATE, no DELETE). This is independent of who the test connects as.

  2. BEHAVIOURAL (``SET LOCAL ROLE service_role``): switch the session to the
     real writer role inside a savepoint, then prove an INSERT still SUCCEEDS
     (the worker append path is unaffected) while an UPDATE and a DELETE are
     REJECTED with ``permission denied`` (``psycopg.errors.InsufficientPrivilege``).
     ``service_role`` is ``nologin bypassrls`` (db/ci-bootstrap.sql): bypassrls
     skips RLS policies but NOT table GRANTs, and it is not a table owner, so
     the revoke actually bites.

Excluded tables (mutated in code: spec_check upsert, sync_log lifecycle,
compliance_finding override, creative_stage_state gate) are NOT covered here --
revoking on them would break the worker; 0041 deliberately leaves them mutable.
"""

from __future__ import annotations

import pytest


pytestmark = pytest.mark.integration


# Tables 0041 makes append-only, and the column set used for a minimal INSERT
# probe + the UPDATE target column. qa_result needs a real creative (it FKs
# creative(id)); the other three are self-contained.
_REVOKED_TABLES = ("events", "pipeline_events", "approval_mode_audit", "qa_result")


# ===========================================================================
# 1. GRANT-level proof (independent of the connecting role).
# ===========================================================================


def _service_role_privs(cur, table: str) -> set[str]:
    """Return the set of privilege types service_role holds on a public table."""
    cur.execute(
        """
        select privilege_type
        from information_schema.role_table_grants
        where grantee = 'service_role'
          and table_schema = 'public'
          and table_name = %s
        """,
        (table,),
    )
    return {row[0] for row in cur.fetchall()}


@pytest.mark.parametrize("table", _REVOKED_TABLES)
def test_service_role_can_append_and_read_only(db_conn, table: str) -> None:
    """service_role holds INSERT + SELECT but NOT UPDATE / DELETE on each table."""
    with db_conn.cursor() as cur:
        privs = _service_role_privs(cur, table)

    assert "INSERT" in privs, f"{table}: service_role must keep INSERT (append)"
    assert "SELECT" in privs, f"{table}: service_role must keep SELECT (read-back)"
    assert "UPDATE" not in privs, f"{table}: UPDATE must be revoked (tamper-block)"
    assert "DELETE" not in privs, f"{table}: DELETE must be revoked (tamper-block)"


@pytest.mark.parametrize(
    "role", ["anon", "authenticated"]
)
@pytest.mark.parametrize("table", _REVOKED_TABLES)
def test_anon_authenticated_have_no_write(db_conn, role: str, table: str) -> None:
    """The public roles never hold UPDATE / DELETE on the audit tables either."""
    with db_conn.cursor() as cur:
        cur.execute(
            """
            select privilege_type
            from information_schema.role_table_grants
            where grantee = %s
              and table_schema = 'public'
              and table_name = %s
            """,
            (role, table),
        )
        privs = {row[0] for row in cur.fetchall()}
    assert "UPDATE" not in privs, f"{table}: {role} must not have UPDATE"
    assert "DELETE" not in privs, f"{table}: {role} must not have DELETE"


# ===========================================================================
# 2. Behavioural proof: act AS service_role and observe insert ok / update+delete denied.
# ===========================================================================


def _insert_event_as_superuser(cur) -> str:
    """Seed one events row (as the current superuser) and return its id."""
    cur.execute(
        "insert into events (kind, payload) values ('audit.test', '{}'::jsonb) returning id"
    )
    return str(cur.fetchone()[0])


def test_events_insert_ok_update_delete_denied(db_conn) -> None:
    """As service_role: INSERT into events succeeds; UPDATE and DELETE are denied."""
    import psycopg

    with db_conn.cursor() as cur:
        # Seed a row first (as superuser) so the UPDATE/DELETE attempts have a
        # target -- proving the denial is the GRANT, not an empty table.
        existing_id = _insert_event_as_superuser(cur)

        cur.execute("set local role service_role")

        # INSERT (the append) must succeed under the writer role.
        cur.execute("savepoint sp_ins")
        cur.execute(
            "insert into events (kind, payload) values ('audit.test', '{}'::jsonb) returning id"
        )
        assert cur.fetchone()[0] is not None
        cur.execute("release savepoint sp_ins")

        # UPDATE must be rejected.
        cur.execute("savepoint sp_upd")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute(
                "update events set kind = 'tampered' where id = %s", (existing_id,)
            )
        cur.execute("rollback to savepoint sp_upd")

        # DELETE must be rejected.
        cur.execute("savepoint sp_del")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute("delete from events where id = %s", (existing_id,))
        cur.execute("rollback to savepoint sp_del")

        cur.execute("reset role")


def test_approval_mode_audit_insert_ok_update_delete_denied(db_conn) -> None:
    """As service_role: approval_mode_audit appends but cannot be rewritten/erased."""
    import psycopg

    with db_conn.cursor() as cur:
        cur.execute(
            """
            insert into approval_mode_audit (from_mode, to_mode, changed_by)
            values ('ASK', 'AUTO_APPROVE', 'tester')
            returning id
            """
        )
        existing_id = str(cur.fetchone()[0])

        cur.execute("set local role service_role")

        cur.execute("savepoint sp_ins")
        cur.execute(
            """
            insert into approval_mode_audit (from_mode, to_mode, changed_by)
            values ('AUTO_APPROVE', 'ASK', 'expired')
            returning id
            """
        )
        assert cur.fetchone()[0] is not None
        cur.execute("release savepoint sp_ins")

        cur.execute("savepoint sp_upd")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute(
                "update approval_mode_audit set to_mode = 'AUTO_APPROVE' where id = %s",
                (existing_id,),
            )
        cur.execute("rollback to savepoint sp_upd")

        cur.execute("savepoint sp_del")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute(
                "delete from approval_mode_audit where id = %s", (existing_id,)
            )
        cur.execute("rollback to savepoint sp_del")

        cur.execute("reset role")


def test_pipeline_events_insert_ok_update_delete_denied(db_conn, image_creative) -> None:
    """As service_role: pipeline_events appends but cannot be rewritten/erased.

    Uses the image_creative fixture only for a valid pipeline_id (the
    pipeline_id FKs pipelines(id) on delete cascade).
    """
    import psycopg

    pid = image_creative["pipeline_id"]
    with db_conn.cursor() as cur:
        cur.execute(
            """
            insert into pipeline_events (pipeline_id, kind, payload)
            values (%s, 'task_error', '{}'::jsonb)
            returning id
            """,
            (pid,),
        )
        existing_id = str(cur.fetchone()[0])

        cur.execute("set local role service_role")

        cur.execute("savepoint sp_ins")
        cur.execute(
            """
            insert into pipeline_events (pipeline_id, kind, payload)
            values (%s, 'task_queued', '{}'::jsonb)
            returning id
            """,
            (pid,),
        )
        assert cur.fetchone()[0] is not None
        cur.execute("release savepoint sp_ins")

        cur.execute("savepoint sp_upd")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute(
                "update pipeline_events set kind = 'tampered' where id = %s",
                (existing_id,),
            )
        cur.execute("rollback to savepoint sp_upd")

        cur.execute("savepoint sp_del")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute(
                "delete from pipeline_events where id = %s", (existing_id,)
            )
        cur.execute("rollback to savepoint sp_del")

        cur.execute("reset role")


def test_qa_result_insert_ok_update_delete_denied(db_conn, image_creative) -> None:
    """As service_role: qa_result appends a new attempt but cannot edit/erase one."""
    import psycopg

    pid = image_creative["pipeline_id"]
    cid = image_creative["creative_id"]
    with db_conn.cursor() as cur:
        cur.execute(
            """
            insert into qa_result (pipeline_id, creative_id, attempt, status, checked_by)
            values (%s, %s, 1, 'pass', 'worker')
            returning id
            """,
            (pid, cid),
        )
        existing_id = str(cur.fetchone()[0])

        cur.execute("set local role service_role")

        # A fresh attempt (the real append path) must succeed.
        cur.execute("savepoint sp_ins")
        cur.execute(
            """
            insert into qa_result (pipeline_id, creative_id, attempt, status, checked_by)
            values (%s, %s, 2, 'fail', 'worker')
            returning id
            """,
            (pid, cid),
        )
        assert cur.fetchone()[0] is not None
        cur.execute("release savepoint sp_ins")

        cur.execute("savepoint sp_upd")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute(
                "update qa_result set status = 'pass' where id = %s", (existing_id,)
            )
        cur.execute("rollback to savepoint sp_upd")

        cur.execute("savepoint sp_del")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute("delete from qa_result where id = %s", (existing_id,))
        cur.execute("rollback to savepoint sp_del")

        cur.execute("reset role")
