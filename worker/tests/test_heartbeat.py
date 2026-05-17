"""Tests for the ``sync_log`` heartbeat helpers (VPS-6).

Covers both public functions exhaustively:

* :func:`log_success` — insert one ``status='ok'`` row, with and without
  the optional ``rows_upserted`` field.
* :func:`last_success_age_seconds` — read back the most recent finish
  time, including the empty-rows, missing-``finished_at``, ``Z``-suffix
  normalisation, naive-datetime, and clock-skew (future) edge cases.

The test doubles mimic the supabase-py chain ``sb.table(name).select(...)
.eq(...).order(...).limit(...).execute()`` with just enough state to
verify the helper's filter shape and return wiring. No real Supabase
client is constructed.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from src.services import heartbeat


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeTable:
    """Chainable stand-in for the supabase-py ``table(...)`` builder."""

    def __init__(self, name: str, parent: "_FakeSupabase") -> None:
        self.name = name
        self.parent = parent
        self._inserted: dict | None = None
        self._select: str | None = None
        self._eqs: list[tuple[str, str]] = []
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None

    def insert(self, data: dict) -> "_FakeTable":
        self._inserted = data
        return self

    def select(self, cols: str) -> "_FakeTable":
        self._select = cols
        return self

    def eq(self, col: str, val: str) -> "_FakeTable":
        self._eqs.append((col, val))
        return self

    def order(self, col: str, *, desc: bool = False) -> "_FakeTable":
        self._order = (col, desc)
        return self

    def limit(self, n: int) -> "_FakeTable":
        self._limit = n
        return self

    def execute(self) -> SimpleNamespace:
        if self._inserted is not None:
            # Capture for the test to inspect.
            self.parent.inserts.append((self.name, dict(self._inserted)))
            return SimpleNamespace(data=[self._inserted])

        # Read path — surface the filters used + return the canned rows.
        self.parent.selects.append(
            {
                "table": self.name,
                "select": self._select,
                "eq": list(self._eqs),
                "order": self._order,
                "limit": self._limit,
            }
        )
        return SimpleNamespace(data=list(self.parent.select_rows))


class _FakeSupabase:
    def __init__(self) -> None:
        self.inserts: list[tuple[str, dict]] = []
        self.selects: list[dict] = []
        self.select_rows: list[dict] = []

    def table(self, name: str) -> _FakeTable:
        return _FakeTable(name, self)


@pytest.fixture
def fake_sb(monkeypatch: pytest.MonkeyPatch) -> _FakeSupabase:
    sb = _FakeSupabase()
    monkeypatch.setattr(heartbeat, "get_supabase_admin", lambda: sb)
    return sb


# ---------------------------------------------------------------------------
# log_success
# ---------------------------------------------------------------------------


def test_log_success_writes_minimal_row(fake_sb: _FakeSupabase) -> None:
    """Without ``rows_upserted`` the inserted row carries only the
    required source / finished_at / status keys."""
    heartbeat.log_success("meta_ads_pull")

    assert len(fake_sb.inserts) == 1
    table, row = fake_sb.inserts[0]
    assert table == "sync_log"
    assert row["source"] == "meta_ads_pull"
    assert row["status"] == "ok"
    # ``finished_at`` is an ISO-8601 UTC timestamp.
    finished = row["finished_at"]
    assert isinstance(finished, str)
    # Parses cleanly back into a tz-aware datetime.
    parsed = datetime.fromisoformat(finished)
    assert parsed.tzinfo is not None
    # No throughput key when the caller didn't provide one.
    assert "rows_upserted" not in row


def test_log_success_includes_rows_upserted(fake_sb: _FakeSupabase) -> None:
    heartbeat.log_success("ghl_pull", rows_upserted=42)

    _, row = fake_sb.inserts[0]
    assert row["rows_upserted"] == 42


def test_log_success_rows_upserted_zero_recorded(fake_sb: _FakeSupabase) -> None:
    """Zero is a legitimate throughput value (an empty-but-successful
    run) and must be persisted — only ``None`` is omitted."""
    heartbeat.log_success("ghl_pull", rows_upserted=0)

    _, row = fake_sb.inserts[0]
    assert row["rows_upserted"] == 0


# ---------------------------------------------------------------------------
# last_success_age_seconds
# ---------------------------------------------------------------------------


def test_last_success_age_seconds_returns_none_when_no_rows(
    fake_sb: _FakeSupabase,
) -> None:
    fake_sb.select_rows = []
    age = heartbeat.last_success_age_seconds("never_ran")
    assert age is None

    # Verify the query shape — filters by source + status, ordered, limit 1.
    last = fake_sb.selects[-1]
    assert last["table"] == "sync_log"
    assert ("source", "never_ran") in last["eq"]
    assert ("status", "ok") in last["eq"]
    assert last["order"] == ("finished_at", True)
    assert last["limit"] == 1


def test_last_success_age_seconds_returns_none_when_data_is_none(
    fake_sb: _FakeSupabase,
) -> None:
    """Supabase occasionally returns ``data=None`` (e.g. on transient
    errors). The helper must coerce that to ``None`` rather than
    crashing."""

    # Monkey-patch the table builder to surface None instead of [].
    class _NoneTable(_FakeTable):
        def execute(self) -> SimpleNamespace:
            return SimpleNamespace(data=None)

    def make_table(name: str) -> _NoneTable:
        return _NoneTable(name, fake_sb)

    fake_sb.table = make_table  # type: ignore[method-assign]
    age = heartbeat.last_success_age_seconds("never_ran")
    assert age is None


def test_last_success_age_seconds_handles_missing_finished_at(
    fake_sb: _FakeSupabase,
) -> None:
    """If somehow a row's ``finished_at`` is missing/None, return None."""
    fake_sb.select_rows = [{"finished_at": None}]
    assert heartbeat.last_success_age_seconds("job") is None

    fake_sb.select_rows = [{"finished_at": ""}]
    assert heartbeat.last_success_age_seconds("job") is None


def test_last_success_age_seconds_normalises_z_suffix(
    fake_sb: _FakeSupabase,
) -> None:
    """``Z`` suffix must be accepted (Supabase emits it on read)."""
    five_min_ago = datetime.now(tz=timezone.utc) - timedelta(seconds=300)
    iso_z = five_min_ago.isoformat().replace("+00:00", "Z")
    fake_sb.select_rows = [{"finished_at": iso_z}]

    age = heartbeat.last_success_age_seconds("job")
    assert age is not None
    # Loosely within five minutes — small slop for test runtime.
    assert 290 <= age <= 320


def test_last_success_age_seconds_handles_plus_zero_suffix(
    fake_sb: _FakeSupabase,
) -> None:
    """``+00:00`` suffix must also be accepted natively."""
    one_min_ago = datetime.now(tz=timezone.utc) - timedelta(seconds=60)
    fake_sb.select_rows = [{"finished_at": one_min_ago.isoformat()}]

    age = heartbeat.last_success_age_seconds("job")
    assert age is not None
    assert 50 <= age <= 90


def test_last_success_age_seconds_assumes_utc_for_naive_strings(
    fake_sb: _FakeSupabase,
) -> None:
    """Old rows may lack a timezone marker; treat them as UTC rather
    than crashing on ``datetime.now() - naive`` arithmetic."""
    two_min_ago = datetime.now(tz=timezone.utc) - timedelta(seconds=120)
    # Strip the timezone to get a naive ISO-8601 string.
    naive_iso = two_min_ago.replace(tzinfo=None).isoformat()
    fake_sb.select_rows = [{"finished_at": naive_iso}]

    age = heartbeat.last_success_age_seconds("job")
    assert age is not None
    assert 110 <= age <= 150


def test_last_success_age_seconds_clamps_negative_to_zero(
    fake_sb: _FakeSupabase,
) -> None:
    """If clock skew leaves ``finished_at`` in the future, return 0
    rather than a negative ``int``."""
    future = datetime.now(tz=timezone.utc) + timedelta(seconds=600)
    fake_sb.select_rows = [{"finished_at": future.isoformat()}]

    age = heartbeat.last_success_age_seconds("job")
    assert age == 0
