"""Tests for the notification event emitter + dedupe.

Each test stubs out the Supabase client with a tiny in-memory ``events`` table
so we don't need a live database.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import MagicMock

import pytest

from src.services import notifications as notif
from src.services.notifications import NotificationEvent, emit


# ---------------------------------------------------------------------------
# Mini in-memory Supabase ``events`` table
# ---------------------------------------------------------------------------


@dataclass
class _Result:
    data: list[dict[str, Any]] = field(default_factory=list)


class _SelectQuery:
    """Mimics ``sb.table('events').select(...).eq(...).gte(...).execute()``."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self._filters: list[tuple[str, str, Any]] = []

    def eq(self, col: str, val: Any) -> "_SelectQuery":
        self._filters.append(("eq", col, val))
        return self

    def gte(self, col: str, val: Any) -> "_SelectQuery":
        self._filters.append(("gte", col, val))
        return self

    def execute(self) -> _Result:
        result = self._rows
        for op, col, val in self._filters:
            if op == "eq":
                result = [r for r in result if r.get(col) == val]
            elif op == "gte":
                result = [r for r in result if r.get(col) >= val]
        return _Result(data=list(result))


class _InsertQuery:
    def __init__(self, rows: list[dict[str, Any]], payload: dict[str, Any]) -> None:
        self._rows = rows
        self._payload = payload

    def execute(self) -> _Result:
        row = {**self._payload, "id": f"evt-{len(self._rows) + 1}"}
        # Stamp a created_at if one isn't provided so the dedupe window query
        # finds us next time.
        row.setdefault("created_at", datetime.now(timezone.utc).isoformat())
        self._rows.append(row)
        return _Result(data=[row])


class _EventsTable:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def select(self, _columns: str) -> _SelectQuery:
        return _SelectQuery(self._rows)

    def insert(self, payload: dict[str, Any]) -> _InsertQuery:
        return _InsertQuery(self._rows, payload)


class _MiniSupabase:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def table(self, name: str) -> _EventsTable:
        assert name == "events", f"unexpected table {name}"
        return _EventsTable(self.events)


@pytest.fixture
def mini_sb(monkeypatch: pytest.MonkeyPatch) -> _MiniSupabase:
    """Replace ``get_supabase_admin`` with a mini in-memory client."""
    sb = _MiniSupabase()
    monkeypatch.setattr(notif, "get_supabase_admin", lambda: sb)
    return sb


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_event(**overrides: Any) -> NotificationEvent:
    base: dict[str, Any] = {
        "kind": "creative_fatigue",
        "ref_table": "campaign_perf_image",
        "ref_id": "11111111-1111-1111-1111-111111111111",
        "payload": {"campaign_id": "cmp-1"},
    }
    base.update(overrides)
    return NotificationEvent(**base)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_emit_inserts_a_new_event(mini_sb: _MiniSupabase) -> None:
    emitted = asyncio.run(emit(_make_event()))
    assert emitted is True
    assert len(mini_sb.events) == 1
    row = mini_sb.events[0]
    assert row["kind"] == "creative_fatigue"
    assert row["ref_table"] == "campaign_perf_image"
    # Dedupe key is stamped into the payload for the next lookup.
    assert row["payload"]["dedupe_key"] == (
        "creative_fatigue:11111111-1111-1111-1111-111111111111"
    )
    # Caller's payload is preserved.
    assert row["payload"]["campaign_id"] == "cmp-1"


def test_emit_dedupes_a_second_call_within_window(mini_sb: _MiniSupabase) -> None:
    first = asyncio.run(emit(_make_event()))
    second = asyncio.run(emit(_make_event()))
    assert first is True
    assert second is False
    assert len(mini_sb.events) == 1


def test_emit_outside_window_inserts_again(
    mini_sb: _MiniSupabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stale row outside dedupe_window_minutes → new emission goes through."""
    # First emission, stamped far in the past.
    asyncio.run(emit(_make_event(dedupe_window_minutes=30)))
    assert len(mini_sb.events) == 1
    # Backdate the row by 2 hours so it falls outside the 30-minute window.
    stale_ts = datetime.now(timezone.utc) - timedelta(hours=2)
    mini_sb.events[0]["created_at"] = stale_ts.isoformat()

    second = asyncio.run(emit(_make_event(dedupe_window_minutes=30)))
    assert second is True
    assert len(mini_sb.events) == 2


def test_distinct_dedupe_keys_emit_separately(mini_sb: _MiniSupabase) -> None:
    """Different ``ref_id`` → different dedupe key → both emit."""
    a = asyncio.run(
        emit(_make_event(ref_id="22222222-2222-2222-2222-222222222222"))
    )
    b = asyncio.run(
        emit(_make_event(ref_id="33333333-3333-3333-3333-333333333333"))
    )
    assert a is True and b is True
    assert len(mini_sb.events) == 2


def test_distinct_kinds_emit_separately(mini_sb: _MiniSupabase) -> None:
    """Different ``kind`` → different dedupe scope, both emit."""
    a = asyncio.run(emit(_make_event(kind="creative_fatigue")))
    b = asyncio.run(emit(_make_event(kind="kill_threshold")))
    assert a is True and b is True
    assert len(mini_sb.events) == 2


def test_custom_dedupe_key_is_respected(mini_sb: _MiniSupabase) -> None:
    """When the caller passes an explicit dedupe key, the same kind+ref_id
    can be emitted under different scopes (e.g. per window)."""
    a = asyncio.run(emit(_make_event(dedupe_key="creative_fatigue:cmp-1:7d")))
    b = asyncio.run(emit(_make_event(dedupe_key="creative_fatigue:cmp-1:30d")))
    c = asyncio.run(emit(_make_event(dedupe_key="creative_fatigue:cmp-1:7d")))
    assert a is True and b is True
    assert c is False  # dedupes against `a`
    assert len(mini_sb.events) == 2
