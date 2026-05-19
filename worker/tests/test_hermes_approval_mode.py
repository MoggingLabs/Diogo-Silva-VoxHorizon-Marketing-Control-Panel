"""Tests for the approval-mode service (Wave 24 — approval-mode-toggle).

Coverage targets:

* ``validate_mode_payload`` — every branch
* ``get_mode`` — happy path, missing row default, Supabase failure
* ``set_mode`` — every mode transition + audit write
* ``set_mode`` — invalid mode / TTL bubble up as InvalidModeError
* ``set_mode`` — Supabase failures surface as ApprovalModeError
* ``set_mode`` — audit insert failure does NOT roll back the state write
* ``get_audit_rows`` — happy path, clamping, failure
* ``get_approval_token`` — env resolution
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from src.services import hermes_approval_mode as service


# ---------------------------------------------------------------------------
# Fake Supabase plumbing
# ---------------------------------------------------------------------------


@dataclass
class _Result:
    data: list[dict[str, Any]] = field(default_factory=list)


class _FakeQuery:
    """Records every method call so tests can assert call shape."""

    def __init__(
        self, parent: "_FakeSupabase", table_name: str
    ) -> None:
        self.parent = parent
        self.table_name = table_name
        self._select: str | None = None
        self._upsert: dict[str, Any] | None = None
        self._upsert_on_conflict: str | None = None
        self._insert: dict[str, Any] | None = None
        self._update: dict[str, Any] | None = None
        self._filters: list[tuple[str, Any]] = []
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None

    def select(self, cols: str) -> "_FakeQuery":
        self._select = cols
        return self

    def upsert(
        self, row: dict[str, Any], on_conflict: str | None = None
    ) -> "_FakeQuery":
        self._upsert = row
        self._upsert_on_conflict = on_conflict
        return self

    def insert(self, row: dict[str, Any]) -> "_FakeQuery":
        self._insert = row
        return self

    def update(self, fields: dict[str, Any]) -> "_FakeQuery":
        self._update = fields
        return self

    def eq(self, col: str, val: Any) -> "_FakeQuery":
        self._filters.append((col, val))
        return self

    def order(self, col: str, desc: bool = False) -> "_FakeQuery":
        self._order = (col, desc)
        return self

    def limit(self, n: int) -> "_FakeQuery":
        self._limit = n
        return self

    def execute(self) -> _Result:
        if (
            self.parent.raise_on_table == self.table_name
            and (
                self.parent.raise_on_op is None
                or self.parent.raise_on_op == self._infer_op()
            )
        ):
            raise RuntimeError(
                f"boom: {self.table_name}/{self._infer_op()}"
            )
        self.parent.calls.append(
            {
                "table": self.table_name,
                "select": self._select,
                "upsert": self._upsert,
                "upsert_on_conflict": self._upsert_on_conflict,
                "insert": self._insert,
                "update": self._update,
                "filters": list(self._filters),
                "order": self._order,
                "limit": self._limit,
            }
        )

        if self._upsert is not None:
            row = dict(self._upsert)
            row_id = row.get("id")
            if row_id is not None:
                self.parent.rows[self.table_name][row_id] = row
            else:
                self.parent.rows[self.table_name][
                    f"_synth_{len(self.parent.rows[self.table_name])}"
                ] = row
            return _Result(data=[row])

        if self._insert is not None:
            row = dict(self._insert)
            key = row.get("id") or f"_ins_{len(self.parent.rows[self.table_name])}"
            self.parent.rows[self.table_name][key] = row
            return _Result(data=[row])

        if self._update is not None:
            matching: list[dict[str, Any]] = []
            for row in self.parent.rows[self.table_name].values():
                if all(row.get(c) == v for c, v in self._filters):
                    row.update(self._update)
                    matching.append(row)
            return _Result(data=matching)

        if self._select is not None:
            out = []
            for row in self.parent.rows[self.table_name].values():
                if all(row.get(c) == v for c, v in self._filters):
                    out.append(row)
            if self._order:
                col, desc = self._order
                out.sort(key=lambda r: r.get(col) or "", reverse=desc)
            if self._limit is not None:
                out = out[: self._limit]
            return _Result(data=out)
        return _Result(data=[])

    def _infer_op(self) -> str:
        if self._upsert is not None:
            return "upsert"
        if self._insert is not None:
            return "insert"
        if self._update is not None:
            return "update"
        if self._select is not None:
            return "select"
        return "unknown"


class _FakeSupabase:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, dict[str, Any]]] = {
            "approval_mode": {},
            "approval_mode_audit": {},
        }
        self.calls: list[dict[str, Any]] = []
        self.raise_on_table: str | None = None
        self.raise_on_op: str | None = None

    def table(self, name: str) -> _FakeQuery:
        if name not in self.rows:
            self.rows[name] = {}
        return _FakeQuery(self, name)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_sb(monkeypatch: pytest.MonkeyPatch) -> _FakeSupabase:
    sb = _FakeSupabase()
    monkeypatch.setattr(service, "get_supabase_admin", lambda: sb)
    return sb


# ---------------------------------------------------------------------------
# validate_mode_payload
# ---------------------------------------------------------------------------


def test_validate_accepts_ask_without_ttl() -> None:
    mode, ttl = service.validate_mode_payload("ASK", None)
    assert mode == "ASK"
    assert ttl is None


def test_validate_accepts_halt_without_ttl() -> None:
    mode, ttl = service.validate_mode_payload("HALT", None)
    assert mode == "HALT"
    assert ttl is None


def test_validate_accepts_auto_approve_with_valid_ttl() -> None:
    mode, ttl = service.validate_mode_payload("AUTO_APPROVE", 3600)
    assert mode == "AUTO_APPROVE"
    assert ttl == 3600


def test_validate_rejects_unknown_mode() -> None:
    with pytest.raises(service.InvalidModeError):
        service.validate_mode_payload("REJECT_ALL", None)


def test_validate_rejects_lowercase_mode() -> None:
    """The CHECK constraint is case-sensitive; mirror that in the validator."""
    with pytest.raises(service.InvalidModeError):
        service.validate_mode_payload("ask", None)


def test_validate_rejects_auto_approve_without_ttl() -> None:
    with pytest.raises(service.InvalidModeError):
        service.validate_mode_payload("AUTO_APPROVE", None)


def test_validate_rejects_auto_approve_with_non_int_ttl() -> None:
    with pytest.raises(service.InvalidModeError):
        service.validate_mode_payload(
            "AUTO_APPROVE", 3600.5  # type: ignore[arg-type]
        )


def test_validate_rejects_auto_approve_with_ttl_below_min() -> None:
    with pytest.raises(service.InvalidModeError):
        service.validate_mode_payload(
            "AUTO_APPROVE", service.MIN_TTL_SECONDS - 1
        )


def test_validate_rejects_auto_approve_with_ttl_above_max() -> None:
    with pytest.raises(service.InvalidModeError):
        service.validate_mode_payload(
            "AUTO_APPROVE", service.MAX_TTL_SECONDS + 1
        )


def test_validate_rejects_ttl_on_ask() -> None:
    with pytest.raises(service.InvalidModeError):
        service.validate_mode_payload("ASK", 3600)


def test_validate_rejects_ttl_on_halt() -> None:
    with pytest.raises(service.InvalidModeError):
        service.validate_mode_payload("HALT", 3600)


# ---------------------------------------------------------------------------
# get_mode
# ---------------------------------------------------------------------------


def test_get_mode_returns_seeded_row(fake_sb: _FakeSupabase) -> None:
    fake_sb.rows["approval_mode"]["singleton"] = {
        "id": "singleton",
        "mode": "ASK",
        "expires_at": None,
        "set_by": "dashboard",
        "set_at": "2026-05-19T00:00:00+00:00",
        "note": None,
    }
    result = asyncio.run(service.get_mode())
    assert result.mode == "ASK"
    assert result.expires_at is None
    assert result.set_by == "dashboard"


def test_get_mode_returns_safe_default_when_row_missing(
    fake_sb: _FakeSupabase,
) -> None:
    """A defensively-safe ASK default when the seed row vanished."""
    result = asyncio.run(service.get_mode())
    assert result.mode == "ASK"
    assert result.expires_at is None


def test_get_mode_returns_auto_approve_with_expiry(
    fake_sb: _FakeSupabase,
) -> None:
    deadline = (
        datetime.now(timezone.utc) + timedelta(hours=4)
    ).isoformat()
    fake_sb.rows["approval_mode"]["singleton"] = {
        "id": "singleton",
        "mode": "AUTO_APPROVE",
        "expires_at": deadline,
        "set_by": "dashboard",
        "set_at": "2026-05-19T00:00:00+00:00",
        "note": "nightly batch",
    }
    result = asyncio.run(service.get_mode())
    assert result.mode == "AUTO_APPROVE"
    assert result.expires_at == deadline
    assert result.note == "nightly batch"


def test_get_mode_surfaces_supabase_failure(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.raise_on_table = "approval_mode"
    fake_sb.raise_on_op = "select"
    with pytest.raises(service.ApprovalModeError):
        asyncio.run(service.get_mode())


def test_get_mode_surfaces_missing_admin_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom() -> Any:
        raise RuntimeError("supabase not configured")

    monkeypatch.setattr(service, "get_supabase_admin", _boom)
    with pytest.raises(service.ApprovalModeError):
        asyncio.run(service.get_mode())


# ---------------------------------------------------------------------------
# set_mode
# ---------------------------------------------------------------------------


def test_set_mode_ask_clears_expires_at(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.rows["approval_mode"]["singleton"] = {
        "id": "singleton",
        "mode": "AUTO_APPROVE",
        "expires_at": "2026-06-01T00:00:00+00:00",
        "set_by": "dashboard",
        "set_at": "2026-05-19T00:00:00+00:00",
        "note": None,
    }
    result = asyncio.run(
        service.set_mode(mode="ASK", changed_by="dashboard")
    )
    assert result.mode == "ASK"
    assert result.expires_at is None
    row = fake_sb.rows["approval_mode"]["singleton"]
    assert row["mode"] == "ASK"
    assert row["expires_at"] is None


def test_set_mode_auto_approve_sets_expires_at(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.rows["approval_mode"]["singleton"] = {
        "id": "singleton",
        "mode": "ASK",
        "expires_at": None,
        "set_by": "dashboard",
        "set_at": "2026-05-19T00:00:00+00:00",
        "note": None,
    }
    result = asyncio.run(
        service.set_mode(
            mode="AUTO_APPROVE",
            ttl_seconds=3600,
            changed_by="dashboard",
            note="batch run",
        )
    )
    assert result.mode == "AUTO_APPROVE"
    assert result.expires_at is not None
    # Audit row was inserted with ttl_seconds=3600.
    audit_rows = list(fake_sb.rows["approval_mode_audit"].values())
    assert len(audit_rows) == 1
    assert audit_rows[0]["from_mode"] == "ASK"
    assert audit_rows[0]["to_mode"] == "AUTO_APPROVE"
    assert audit_rows[0]["ttl_seconds"] == 3600
    assert audit_rows[0]["changed_by"] == "dashboard"
    assert audit_rows[0]["note"] == "batch run"


def test_set_mode_halt(fake_sb: _FakeSupabase) -> None:
    result = asyncio.run(
        service.set_mode(mode="HALT", changed_by="dashboard")
    )
    assert result.mode == "HALT"
    assert result.expires_at is None
    audit_rows = list(fake_sb.rows["approval_mode_audit"].values())
    assert audit_rows[0]["to_mode"] == "HALT"
    assert audit_rows[0]["ttl_seconds"] is None


def test_set_mode_records_from_mode_correctly(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.rows["approval_mode"]["singleton"] = {
        "id": "singleton",
        "mode": "HALT",
        "expires_at": None,
        "set_by": "dashboard",
        "set_at": "2026-05-19T00:00:00+00:00",
        "note": None,
    }
    asyncio.run(
        service.set_mode(mode="ASK", changed_by="dashboard")
    )
    audit_rows = list(fake_sb.rows["approval_mode_audit"].values())
    assert audit_rows[0]["from_mode"] == "HALT"
    assert audit_rows[0]["to_mode"] == "ASK"


def test_set_mode_first_transition_uses_ask_as_default_from_mode(
    fake_sb: _FakeSupabase,
) -> None:
    """When the singleton is missing (shouldn't happen), default from to ASK."""
    asyncio.run(
        service.set_mode(
            mode="AUTO_APPROVE", ttl_seconds=3600, changed_by="dashboard"
        )
    )
    audit_rows = list(fake_sb.rows["approval_mode_audit"].values())
    assert audit_rows[0]["from_mode"] == "ASK"


def test_set_mode_invalid_raises_validation_error(
    fake_sb: _FakeSupabase,
) -> None:
    with pytest.raises(service.InvalidModeError):
        asyncio.run(service.set_mode(mode="NOPE"))


def test_set_mode_pre_select_failure_surfaces(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.raise_on_table = "approval_mode"
    fake_sb.raise_on_op = "select"
    with pytest.raises(service.ApprovalModeError):
        asyncio.run(service.set_mode(mode="HALT"))


def test_set_mode_upsert_failure_surfaces(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.raise_on_table = "approval_mode"
    fake_sb.raise_on_op = "upsert"
    with pytest.raises(service.ApprovalModeError):
        asyncio.run(service.set_mode(mode="HALT"))


def test_set_mode_audit_failure_does_not_unwind_state_write(
    fake_sb: _FakeSupabase,
) -> None:
    """If the audit insert blows up the singleton MUST stay set."""
    fake_sb.raise_on_table = "approval_mode_audit"
    fake_sb.raise_on_op = "insert"
    result = asyncio.run(service.set_mode(mode="HALT"))
    assert result.mode == "HALT"
    row = fake_sb.rows["approval_mode"]["singleton"]
    assert row["mode"] == "HALT"


def test_set_mode_changed_by_defaults_to_dashboard(
    fake_sb: _FakeSupabase,
) -> None:
    asyncio.run(service.set_mode(mode="HALT"))
    audit_rows = list(fake_sb.rows["approval_mode_audit"].values())
    assert audit_rows[0]["changed_by"] == "dashboard"


def test_set_mode_custom_changed_by(
    fake_sb: _FakeSupabase,
) -> None:
    asyncio.run(
        service.set_mode(mode="HALT", changed_by="ops-bot")
    )
    audit_rows = list(fake_sb.rows["approval_mode_audit"].values())
    assert audit_rows[0]["changed_by"] == "ops-bot"


# ---------------------------------------------------------------------------
# get_audit_rows
# ---------------------------------------------------------------------------


def test_get_audit_rows_returns_in_order(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.rows["approval_mode_audit"] = {
        "a": {
            "id": "a",
            "from_mode": "ASK",
            "to_mode": "AUTO_APPROVE",
            "ttl_seconds": 3600,
            "changed_at": "2026-05-19T10:00:00+00:00",
            "changed_by": "dashboard",
            "note": "morning",
        },
        "b": {
            "id": "b",
            "from_mode": "AUTO_APPROVE",
            "to_mode": "ASK",
            "ttl_seconds": None,
            "changed_at": "2026-05-19T14:00:00+00:00",
            "changed_by": "expired",
            "note": None,
        },
    }
    rows = asyncio.run(service.get_audit_rows(limit=10))
    # Newest first.
    assert rows[0].id == "b"
    assert rows[1].id == "a"


def test_get_audit_rows_clamps_low_limit(
    fake_sb: _FakeSupabase,
) -> None:
    captured: dict[str, int] = {}

    real_table = fake_sb.table

    def _spy_table(name: str) -> _FakeQuery:
        q = real_table(name)
        original_limit = q.limit

        def _capture(n: int) -> Any:
            captured["limit"] = n
            return original_limit(n)

        q.limit = _capture  # type: ignore[assignment]
        return q

    fake_sb.table = _spy_table  # type: ignore[assignment]
    asyncio.run(service.get_audit_rows(limit=-5))
    assert captured["limit"] == 1


def test_get_audit_rows_clamps_high_limit(
    fake_sb: _FakeSupabase,
) -> None:
    captured: dict[str, int] = {}

    real_table = fake_sb.table

    def _spy_table(name: str) -> _FakeQuery:
        q = real_table(name)
        original_limit = q.limit

        def _capture(n: int) -> Any:
            captured["limit"] = n
            return original_limit(n)

        q.limit = _capture  # type: ignore[assignment]
        return q

    fake_sb.table = _spy_table  # type: ignore[assignment]
    asyncio.run(service.get_audit_rows(limit=999_999))
    assert captured["limit"] == service.MAX_AUDIT_LIMIT


def test_get_audit_rows_surfaces_failure(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.raise_on_table = "approval_mode_audit"
    fake_sb.raise_on_op = "select"
    with pytest.raises(service.ApprovalModeError):
        asyncio.run(service.get_audit_rows(limit=10))


def test_get_audit_rows_empty(
    fake_sb: _FakeSupabase,
) -> None:
    rows = asyncio.run(service.get_audit_rows(limit=10))
    assert rows == []


def test_get_audit_rows_default_limit(
    fake_sb: _FakeSupabase,
) -> None:
    """Default `limit` parameter is honored when the caller omits it."""
    rows = asyncio.run(service.get_audit_rows())
    assert rows == []


# ---------------------------------------------------------------------------
# get_approval_token
# ---------------------------------------------------------------------------


def test_get_approval_token_returns_env_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VOXHORIZON_APPROVAL_TOKEN", "secret-x")
    assert service.get_approval_token() == "secret-x"


def test_get_approval_token_strips_whitespace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VOXHORIZON_APPROVAL_TOKEN", "  secret-x  ")
    assert service.get_approval_token() == "secret-x"


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
