"""Tests for the Hermes approval long-poll service (HI-14).

Coverage targets:

* ``request_approval`` happy path (operator approves)
* ``request_approval`` reject + caveat decisions
* ``request_approval`` idempotency (re-POST returns existing decision)
* ``request_approval`` timeout (row flips to ``expired``)
* ``request_approval`` cancel-mid-poll (row flips to ``cancelled``)
* ``request_approval`` row vanishing mid-poll
* ``request_approval`` short-circuit when row is already
  decided/cancelled/expired
* ``request_approval`` short-circuit when row is pending (no UPSERT)
* ``request_approval`` Supabase failures surface as ``ApprovalError``
* ``request_approval`` expiry write failure is best-effort (no raise)
* ``cancel_approval`` happy path + idempotent re-cancel
* ``cancel_approval`` Supabase failure surface
* ``get_approval`` happy path + missing
* ``acquire_slot`` cap enforcement (11th returns None) + recovery
* ``get_approval_token`` env resolution

The Supabase client is replaced with an in-memory fake table that lets
tests script status transitions over time. We never sleep more than
``POLL_INTERVAL_S * (a few)`` so the suite stays fast.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import pytest

from src.services import hermes_approval as service


# ---------------------------------------------------------------------------
# Fake Supabase plumbing
# ---------------------------------------------------------------------------


@dataclass
class _Result:
    data: list[dict[str, Any]] = field(default_factory=list)


class _FakeQuery:
    """Builder that records every method call so tests can assert call shape."""

    def __init__(self, parent: "_FakeSupabase", table_name: str) -> None:
        self.parent = parent
        self.table_name = table_name
        self._select: str | None = None
        self._upsert: dict[str, Any] | None = None
        self._upsert_on_conflict: str | None = None
        self._update: dict[str, Any] | None = None
        self._filters: list[tuple[str, Any]] = []

    def select(self, cols: str) -> "_FakeQuery":
        self._select = cols
        return self

    def upsert(
        self,
        row: dict[str, Any],
        on_conflict: str | None = None,
    ) -> "_FakeQuery":
        self._upsert = row
        self._upsert_on_conflict = on_conflict
        return self

    def update(self, fields: dict[str, Any]) -> "_FakeQuery":
        self._update = fields
        return self

    def eq(self, col: str, val: Any) -> "_FakeQuery":
        self._filters.append((col, val))
        return self

    def execute(self) -> _Result:
        # If the test wants a specific table call to blow up, do it here.
        if self.parent.raise_on == self.table_name:
            raise RuntimeError(f"boom: {self.table_name}")

        # Record the call before mutating fake state so tests can audit.
        self.parent.calls.append(
            {
                "table": self.table_name,
                "select": self._select,
                "upsert": self._upsert,
                "upsert_on_conflict": self._upsert_on_conflict,
                "update": self._update,
                "filters": list(self._filters),
            }
        )

        # Optional driver: tests can advance per-call state by registering a
        # callback that runs after the call is recorded.
        if self.parent.on_call:
            self.parent.on_call(self.parent)

        # UPSERT path: write into the in-memory row store, keyed on id.
        if self._upsert is not None:
            row = dict(self._upsert)
            row_id = row["id"]
            self.parent.rows[row_id] = row
            return _Result(data=[row])

        # UPDATE path: filtered by id (+ optional extra filters), apply
        # mutation to matching rows.
        if self._update is not None:
            matching: list[dict[str, Any]] = []
            for row in self.parent.rows.values():
                if all(row.get(c) == v for c, v in self._filters):
                    row.update(self._update)
                    matching.append(row)
            return _Result(data=matching)

        # SELECT path: filtered by id, return matching rows.
        if self._select is not None:
            out = []
            for row in self.parent.rows.values():
                if all(row.get(c) == v for c, v in self._filters):
                    out.append(row)
            return _Result(data=out)

        return _Result(data=[])


class _FakeSupabase:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}
        self.calls: list[dict[str, Any]] = []
        self.raise_on: str | None = None
        # Optional driver that fires after each .execute(); used by tests
        # that want to flip a row's status mid-poll without racing real time.
        self.on_call: Any = None

    def table(self, name: str) -> _FakeQuery:
        return _FakeQuery(self, name)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_sb(monkeypatch: pytest.MonkeyPatch) -> _FakeSupabase:
    sb = _FakeSupabase()
    monkeypatch.setattr(service, "get_supabase_admin", lambda: sb)
    return sb


@pytest.fixture(autouse=True)
def _reset() -> None:
    """Clear the module-level slot counter between tests."""
    service._reset_slots()
    yield
    service._reset_slots()


@pytest.fixture
def fast_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    """Speed up the poll loop so timeout tests finish in <1s."""
    monkeypatch.setattr(service, "POLL_INTERVAL_S", 0.01)


def _kwargs(approval_id: str = "ap-1") -> dict[str, Any]:
    """Reusable kwargs for :func:`service.request_approval` calls."""
    return {
        "approval_id": approval_id,
        "ekko_session_id": "sess-1",
        "ekko_tool_call_id": "tc-1",
        "tool_name": "BashTool",
        "tool_args": {"command": "rm -rf /tmp/x"},
        "risk_class": "fs",
        "context": {"why": "cleanup"},
    }


# ---------------------------------------------------------------------------
# request_approval — happy paths
# ---------------------------------------------------------------------------


def test_request_approval_returns_decision_after_operator_approves(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    """Once the row's status flips to 'decided', the call returns."""

    flips: dict[str, int] = {"select": 0}

    def _driver(sb: _FakeSupabase) -> None:
        flips["select"] += 1
        # After the second poll-SELECT, mark the row decided.
        if flips["select"] >= 2:
            row = sb.rows.get("ap-1")
            if row and row["status"] == "pending":
                row["status"] = "decided"
                row["decision"] = "approved"
                row["decision_notes"] = "looks fine"

    fake_sb.on_call = _driver

    result = asyncio.run(
        service.request_approval(**_kwargs(), timeout_s=10)
    )
    assert result.decision == "approved"
    assert result.notes == "looks fine"
    assert "ap-1" in fake_sb.rows


def test_request_approval_returns_caveat_decision(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    flips: dict[str, int] = {"select": 0}

    def _driver(sb: _FakeSupabase) -> None:
        flips["select"] += 1
        if flips["select"] >= 2:
            row = sb.rows.get("ap-1")
            if row and row["status"] == "pending":
                row["status"] = "decided"
                row["decision"] = "approved_with_caveat"
                row["decision_notes"] = "OK but only this once"

    fake_sb.on_call = _driver

    result = asyncio.run(
        service.request_approval(**_kwargs(), timeout_s=10)
    )
    assert result.decision == "approved_with_caveat"
    assert result.notes == "OK but only this once"


def test_request_approval_returns_rejected(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    def _driver(sb: _FakeSupabase) -> None:
        row = sb.rows.get("ap-1")
        if row and row["status"] == "pending":
            row["status"] = "decided"
            row["decision"] = "rejected"
            row["decision_notes"] = "too risky"

    fake_sb.on_call = _driver

    result = asyncio.run(
        service.request_approval(**_kwargs(), timeout_s=10)
    )
    assert result.decision == "rejected"
    assert result.notes == "too risky"


def test_request_approval_handles_null_decision_on_decided_row(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    """If a decided row somehow has null decision, fall back to rejected.

    This shouldn't happen by schema invariants but we never want to
    propagate None to the plugin.
    """

    def _driver(sb: _FakeSupabase) -> None:
        row = sb.rows.get("ap-1")
        if row and row["status"] == "pending":
            row["status"] = "decided"
            row["decision"] = None
            row["decision_notes"] = None

    fake_sb.on_call = _driver

    result = asyncio.run(
        service.request_approval(**_kwargs(), timeout_s=10)
    )
    assert result.decision == "rejected"
    assert result.notes is None


# ---------------------------------------------------------------------------
# request_approval — idempotency
# ---------------------------------------------------------------------------


def test_request_approval_idempotent_returns_existing_decision(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    """Re-POSTing on an already-decided id short-circuits to the decision."""
    fake_sb.rows["ap-1"] = {
        "id": "ap-1",
        "status": "decided",
        "decision": "approved",
        "decision_notes": "from-previous-poll",
    }
    result = asyncio.run(
        service.request_approval(**_kwargs(), timeout_s=10)
    )
    assert result.decision == "approved"
    assert result.notes == "from-previous-poll"
    # Crucially: no upsert was issued (we never re-create a decided row).
    upserts = [c for c in fake_sb.calls if c["upsert"] is not None]
    assert upserts == []


def test_request_approval_idempotent_on_cancelled_existing(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    fake_sb.rows["ap-1"] = {
        "id": "ap-1",
        "status": "cancelled",
        "decision": None,
        "decision_notes": None,
    }
    result = asyncio.run(
        service.request_approval(**_kwargs(), timeout_s=10)
    )
    assert result.decision == "rejected"
    assert "cancelled" in (result.notes or "").lower()


def test_request_approval_idempotent_on_expired_existing(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    fake_sb.rows["ap-1"] = {
        "id": "ap-1",
        "status": "expired",
        "decision": None,
        "decision_notes": None,
    }
    result = asyncio.run(
        service.request_approval(**_kwargs(), timeout_s=10)
    )
    assert result.decision == "rejected"
    assert "timeout" in (result.notes or "").lower()


def test_request_approval_idempotent_on_pending_existing_skips_upsert(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    """Pending existing row → poll it, don't UPSERT (preserves expires_at)."""
    fake_sb.rows["ap-1"] = {
        "id": "ap-1",
        "status": "pending",
        "decision": None,
        "decision_notes": None,
    }

    def _driver(sb: _FakeSupabase) -> None:
        row = sb.rows.get("ap-1")
        if row and row["status"] == "pending":
            row["status"] = "decided"
            row["decision"] = "approved"

    fake_sb.on_call = _driver

    result = asyncio.run(
        service.request_approval(**_kwargs(), timeout_s=10)
    )
    assert result.decision == "approved"
    upserts = [c for c in fake_sb.calls if c["upsert"] is not None]
    assert upserts == []


# ---------------------------------------------------------------------------
# request_approval — timeout / cancel / vanish
# ---------------------------------------------------------------------------


def test_request_approval_times_out_and_marks_expired(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    # No driver — row stays pending forever; we expect timeout.
    # Pick a small timeout so the test finishes promptly.
    result = asyncio.run(
        service.request_approval(**_kwargs(), timeout_s=0.05)
    )
    assert result.decision == "rejected"
    assert "timeout" in (result.notes or "").lower()
    # The row is now flipped to expired by the cleanup UPDATE.
    assert fake_sb.rows["ap-1"]["status"] == "expired"


def test_request_approval_cancel_mid_poll(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    def _driver(sb: _FakeSupabase) -> None:
        row = sb.rows.get("ap-1")
        if row and row["status"] == "pending":
            row["status"] = "cancelled"

    fake_sb.on_call = _driver

    result = asyncio.run(
        service.request_approval(**_kwargs(), timeout_s=10)
    )
    assert result.decision == "rejected"
    assert "cancelled" in (result.notes or "").lower()


def test_request_approval_observes_expired_mid_poll(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    """Race: another process flips the row to 'expired' during our poll."""

    def _driver(sb: _FakeSupabase) -> None:
        row = sb.rows.get("ap-1")
        if row and row["status"] == "pending":
            row["status"] = "expired"

    fake_sb.on_call = _driver

    result = asyncio.run(
        service.request_approval(**_kwargs(), timeout_s=10)
    )
    assert result.decision == "rejected"
    assert "timeout" in (result.notes or "").lower()


def test_request_approval_row_disappears_mid_poll(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    """Truly unexpected: the row was deleted. Don't spin; return rejected."""

    def _driver(sb: _FakeSupabase) -> None:
        sb.rows.pop("ap-1", None)

    fake_sb.on_call = _driver

    result = asyncio.run(
        service.request_approval(**_kwargs(), timeout_s=10)
    )
    assert result.decision == "rejected"
    assert "disappear" in (result.notes or "").lower()


def test_request_approval_expire_write_failure_is_best_effort(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    """If the expiry UPDATE fails, we still return a clean timeout decision."""

    # Drive: after we time out, the cleanup UPDATE raises. The poll
    # SELECT calls must succeed first, so we don't set raise_on globally.
    state = {"selects": 0}

    def _driver(sb: _FakeSupabase) -> None:
        state["selects"] += 1

    fake_sb.on_call = _driver

    original_table = fake_sb.table

    def _table(name: str) -> Any:
        q = original_table(name)
        original_execute = q.execute

        def _execute() -> Any:
            # If the call is the UPDATE → "expired", raise; everything
            # else passes through.
            if q._update == {"status": "expired"}:
                raise RuntimeError("expire write blew up")
            return original_execute()

        q.execute = _execute  # type: ignore[assignment]
        return q

    fake_sb.table = _table  # type: ignore[assignment]

    result = asyncio.run(
        service.request_approval(**_kwargs(), timeout_s=0.05)
    )
    assert result.decision == "rejected"
    assert "timeout" in (result.notes or "").lower()


# ---------------------------------------------------------------------------
# request_approval — Supabase failures surface as ApprovalError
# ---------------------------------------------------------------------------


def test_request_approval_raises_when_supabase_client_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _broken() -> Any:
        raise RuntimeError("no supabase")

    monkeypatch.setattr(service, "get_supabase_admin", _broken)
    with pytest.raises(service.ApprovalError) as exc:
        asyncio.run(service.request_approval(**_kwargs(), timeout_s=1))
    assert "Supabase" in str(exc.value)


def test_request_approval_raises_when_select_fails(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    fake_sb.raise_on = "approvals"
    with pytest.raises(service.ApprovalError):
        asyncio.run(service.request_approval(**_kwargs(), timeout_s=1))


def test_request_approval_raises_when_upsert_fails(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    """The first SELECT returns nothing → UPSERT runs → UPSERT blows up."""
    original_table = fake_sb.table

    def _table(name: str) -> Any:
        q = original_table(name)
        original_execute = q.execute

        def _execute() -> Any:
            if q._upsert is not None:
                raise RuntimeError("upsert blew up")
            return original_execute()

        q.execute = _execute  # type: ignore[assignment]
        return q

    fake_sb.table = _table  # type: ignore[assignment]

    with pytest.raises(service.ApprovalError):
        asyncio.run(service.request_approval(**_kwargs(), timeout_s=1))


def test_request_approval_raises_when_poll_select_fails(
    fake_sb: _FakeSupabase, fast_poll: None
) -> None:
    """The initial SELECT succeeds, then a subsequent poll SELECT fails."""
    state = {"selects": 0}
    original_table = fake_sb.table

    def _table(name: str) -> Any:
        q = original_table(name)
        original_execute = q.execute

        def _execute() -> Any:
            # Only fail on SELECTs (no upsert / update fields set), and
            # only after the first one has succeeded.
            if (
                q._select is not None
                and q._upsert is None
                and q._update is None
            ):
                state["selects"] += 1
                if state["selects"] > 1:
                    raise RuntimeError("poll select blew up")
            return original_execute()

        q.execute = _execute  # type: ignore[assignment]
        return q

    fake_sb.table = _table  # type: ignore[assignment]

    with pytest.raises(service.ApprovalError):
        asyncio.run(service.request_approval(**_kwargs(), timeout_s=1))


# ---------------------------------------------------------------------------
# cancel_approval
# ---------------------------------------------------------------------------


def test_cancel_approval_flips_pending(fake_sb: _FakeSupabase) -> None:
    fake_sb.rows["ap-1"] = {"id": "ap-1", "status": "pending"}
    ok = asyncio.run(service.cancel_approval("ap-1"))
    assert ok is True
    assert fake_sb.rows["ap-1"]["status"] == "cancelled"


def test_cancel_approval_noop_on_already_decided(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.rows["ap-1"] = {
        "id": "ap-1",
        "status": "decided",
        "decision": "approved",
    }
    ok = asyncio.run(service.cancel_approval("ap-1"))
    assert ok is False
    assert fake_sb.rows["ap-1"]["status"] == "decided"


def test_cancel_approval_noop_on_missing(fake_sb: _FakeSupabase) -> None:
    ok = asyncio.run(service.cancel_approval("nope"))
    assert ok is False


def test_cancel_approval_supabase_unavailable_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _broken() -> Any:
        raise RuntimeError("no supabase")

    monkeypatch.setattr(service, "get_supabase_admin", _broken)
    with pytest.raises(service.ApprovalError):
        asyncio.run(service.cancel_approval("ap-1"))


def test_cancel_approval_update_failure_raises(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.raise_on = "approvals"
    with pytest.raises(service.ApprovalError):
        asyncio.run(service.cancel_approval("ap-1"))


# ---------------------------------------------------------------------------
# get_approval
# ---------------------------------------------------------------------------


def test_get_approval_returns_row(fake_sb: _FakeSupabase) -> None:
    fake_sb.rows["ap-1"] = {"id": "ap-1", "status": "pending"}
    row = asyncio.run(service.get_approval("ap-1"))
    assert row is not None
    assert row["id"] == "ap-1"


def test_get_approval_returns_none_for_missing(
    fake_sb: _FakeSupabase,
) -> None:
    row = asyncio.run(service.get_approval("missing"))
    assert row is None


def test_get_approval_supabase_unavailable_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _broken() -> Any:
        raise RuntimeError("no supabase")

    monkeypatch.setattr(service, "get_supabase_admin", _broken)
    with pytest.raises(service.ApprovalError):
        asyncio.run(service.get_approval("ap-1"))


def test_get_approval_select_failure_raises(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.raise_on = "approvals"
    with pytest.raises(service.ApprovalError):
        asyncio.run(service.get_approval("ap-1"))


# ---------------------------------------------------------------------------
# Concurrency cap
# ---------------------------------------------------------------------------


def test_acquire_slot_up_to_cap_then_returns_none() -> None:
    async def _run() -> None:
        guards = []
        for _ in range(service.MAX_CONCURRENT):
            g = await service.acquire_slot()
            assert g is not None
            guards.append(g)
        # 11th request gets a None
        denied = await service.acquire_slot()
        assert denied is None
        # Release one and the next acquire succeeds.
        await guards[0].__aexit__(None, None, None)
        again = await service.acquire_slot()
        assert again is not None
        # Cleanup
        for g in guards[1:]:
            await g.__aexit__(None, None, None)
        await again.__aexit__(None, None, None)

    asyncio.run(_run())


def test_slot_count_clamped_at_zero() -> None:
    """Manually-released slot doesn't underflow even on double-release."""

    async def _run() -> None:
        g = await service.acquire_slot()
        assert g is not None
        await g.__aexit__(None, None, None)
        await g.__aexit__(None, None, None)
        assert service._current_slot_count() == 0

    asyncio.run(_run())


def test_slot_guard_releases_on_normal_exit() -> None:
    async def _run() -> None:
        g = await service.acquire_slot()
        assert g is not None
        assert service._current_slot_count() == 1
        async with g:
            assert service._current_slot_count() == 1
        assert service._current_slot_count() == 0

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Token resolver
# ---------------------------------------------------------------------------


def test_get_approval_token_returns_env_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VOXHORIZON_APPROVAL_TOKEN", "  test-token  ")
    assert service.get_approval_token() == "test-token"


def test_get_approval_token_returns_none_when_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("VOXHORIZON_APPROVAL_TOKEN", raising=False)
    assert service.get_approval_token() is None


def test_get_approval_token_returns_none_when_blank(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VOXHORIZON_APPROVAL_TOKEN", "   ")
    assert service.get_approval_token() is None


# ---------------------------------------------------------------------------
# Minor: ApprovalDecision dataclass / now helper
# ---------------------------------------------------------------------------


def test_approval_decision_is_frozen() -> None:
    """Decisions are immutable so the route can pass them around safely."""
    d = service.ApprovalDecision(decision="approved", notes="ok")
    with pytest.raises(Exception):
        d.decision = "rejected"  # type: ignore[misc]


def test_now_utc_returns_timezone_aware() -> None:
    """The clock helper always returns an aware datetime."""
    ts = service._now_utc()
    assert ts.tzinfo is not None
