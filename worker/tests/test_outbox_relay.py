"""Tests for the transactional-outbox relay (E5.1 / #510).

``services.outbox_relay.run_outbox_relay_once`` is the drain half of the
exactly-once external-write path: it claims due ``integration_outbox`` rows,
performs a registered side effect, and records the outcome (done / exponential
backoff / dead-letter). We assert:

  * a due row is CLAIMED, its handler runs, and it is marked ``done`` + result;
  * a handler failure BACKS OFF (status -> pending, attempts bumped,
    next_attempt_at pushed out by the backoff schedule) and is retried later;
  * a row that exhausts ``scheduler_outbox_max_attempts`` is DEAD-LETTERED;
  * an :class:`OutboxRelayError` dead-letters immediately (no backoff);
  * the pass is BOUNDED per ``scheduler_outbox_max_per_pass``;
  * a not-yet-due row (next_attempt_at in the future) is left untouched;
  * an unhandled ``(integration, op)`` is skipped (attempts NOT burned);
  * one bad row never aborts the sweep (the others still drain);
  * an empty due-set is a logged no-op;
  * the SKIP-LOCKED claim RPC fast path is used when present, REST fallback else;
  * the relay is wired into the scheduler.

The claim is concurrency-sensitive, so this file uses a purpose-built
``_OutboxFake`` whose ``update`` honours the status guard (returns no rows when
the guard doesn't match) -- the shared ``FakeSupabase`` double echoes a
synthetic row on a no-match update, which would mask the guard. The fake is the
minimal slice the relay touches: ``table().select().eq().order().limit()`` reads,
status-guarded ``update``, and ``rpc().execute()``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from src.config import get_settings
from src.services import outbox_relay
from src.services.outbox_relay import OutboxRelayError, backoff_seconds


# ---------------------------------------------------------------------------
# Settings helper (fresh, override-able, never mutates the cached singleton)
# ---------------------------------------------------------------------------


def _settings(**over: object):  # noqa: ANN202
    get_settings.cache_clear()
    s = get_settings()
    return s.model_copy(update=dict(over)) if over else s


# ---------------------------------------------------------------------------
# Purpose-built outbox fake (honours the status-guarded claim)
# ---------------------------------------------------------------------------


class _OutboxQuery:
    def __init__(self, fake: "_OutboxFake") -> None:
        self._f = fake
        self._filters: list[tuple[str, Any]] = []
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None
        self._select = False
        self._maybe_single = False
        self._insert: Any = None
        self._update: dict[str, Any] | None = None

    def select(self, _cols: str = "*", **_kw: Any) -> "_OutboxQuery":
        self._select = True
        return self

    def eq(self, col: str, val: Any) -> "_OutboxQuery":
        self._filters.append((col, val))
        return self

    def order(self, col: str, *, desc: bool = False) -> "_OutboxQuery":
        self._order = (col, desc)
        return self

    def limit(self, n: int) -> "_OutboxQuery":
        self._limit = n
        return self

    def maybe_single(self) -> "_OutboxQuery":
        self._maybe_single = True
        return self

    def insert(self, data: Any) -> "_OutboxQuery":
        self._insert = data
        return self

    def update(self, data: dict[str, Any]) -> "_OutboxQuery":
        self._update = data
        return self

    def _matches(self, row: dict[str, Any]) -> bool:
        return all(row.get(c) == v for c, v in self._filters)

    def execute(self):  # noqa: ANN201
        from types import SimpleNamespace

        if self._insert is not None:
            rows = self._insert if isinstance(self._insert, list) else [self._insert]
            out = []
            for r in rows:
                nr = dict(r)
                nr.setdefault("id", f"row-{len(self._f.store) + 1}")
                self._f.store.append(nr)
                out.append(nr)
            return SimpleNamespace(data=out)
        if self._update is not None:
            updated = []
            for row in self._f.store:
                if self._matches(row):
                    row.update(self._update)
                    updated.append(row)
            # No synthetic echo: a guarded update that matched nothing returns []
            # so the relay's claim guard sees the loss honestly.
            return SimpleNamespace(data=updated)
        rows = [r for r in self._f.store if self._matches(r)]
        if self._order:
            col, desc = self._order
            rows = sorted(
                rows, key=lambda r: (r.get(col) is None, r.get(col)), reverse=desc
            )
        if self._limit is not None:
            rows = rows[: self._limit]
        if self._maybe_single:
            return SimpleNamespace(data=rows[0]) if rows else None
        return SimpleNamespace(data=rows)


class _Rpc:
    def __init__(self, value: Any) -> None:
        self._v = value

    def execute(self):  # noqa: ANN201
        from types import SimpleNamespace

        return SimpleNamespace(data=self._v)


class _OutboxFake:
    """Minimal supabase double the relay drives, honouring the status guard."""

    def __init__(self, *, rpc_unavailable: bool = True) -> None:
        self.store: list[dict[str, Any]] = []
        self.rpc_calls: list[tuple[str, dict[str, Any]]] = []
        self._rpc_unavailable = rpc_unavailable
        self.rpc_claim: Any = None  # set to a list to exercise the RPC fast path

    def seed(self, rows: list[dict[str, Any]]) -> None:
        for r in rows:
            nr = dict(r)
            nr.setdefault("id", f"row-{len(self.store) + 1}")
            self.store.append(nr)

    def row(self, row_id: str) -> dict[str, Any] | None:
        return next((r for r in self.store if r.get("id") == row_id), None)

    def table(self, _name: str) -> _OutboxQuery:
        return _OutboxQuery(self)

    def rpc(self, fn: str, params: dict[str, Any]) -> _Rpc:
        self.rpc_calls.append((fn, dict(params)))
        if self._rpc_unavailable:
            raise RuntimeError("function claim_due_integration_outbox does not exist")
        return _Rpc(self.rpc_claim)


def _due_row(**over: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": over.pop("id", "ob-1"),
        "pipeline_id": "p-1",
        "integration": "meta",
        "op": "record_launch",
        "idempotency_key": "k-1",
        "request": {"pipeline_id": "p-1"},
        "status": "pending",
        "attempts": 0,
        "next_attempt_at": "2000-01-01T00:00:00Z",  # long past -> due
    }
    row.update(over)
    return row


async def _ok_handler(_req):  # noqa: ANN001, ANN202
    return {"acknowledged": True}


# ===========================================================================
# backoff math (pure)
# ===========================================================================


def test_backoff_doubles_and_caps() -> None:
    assert backoff_seconds(1, base_s=30.0, cap_s=3600.0) == 30.0
    assert backoff_seconds(2, base_s=30.0, cap_s=3600.0) == 60.0
    assert backoff_seconds(3, base_s=30.0, cap_s=3600.0) == 120.0
    # Caps once the doubling exceeds the cap.
    assert backoff_seconds(20, base_s=30.0, cap_s=3600.0) == 3600.0
    # Defensive: a non-positive attempt collapses to base.
    assert backoff_seconds(0, base_s=30.0, cap_s=3600.0) == 30.0


# ===========================================================================
# claim + success
# ===========================================================================


async def test_claims_due_row_runs_handler_marks_done() -> None:
    sb = _OutboxFake()
    sb.seed([_due_row()])
    calls: list[dict[str, Any]] = []

    async def handler(req):  # noqa: ANN001, ANN202
        calls.append(dict(req))
        return {"acknowledged": True}

    res = await outbox_relay.run_outbox_relay_once(
        _settings(), handlers={("meta", "record_launch"): handler}, sb=sb
    )
    assert res.claimed == 1
    assert res.done == 1
    assert calls == [{"pipeline_id": "p-1"}]
    row = sb.row("ob-1")
    assert row is not None
    assert row["status"] == "done"
    assert row["result"] == {"acknowledged": True}


async def test_not_due_row_is_left_untouched() -> None:
    sb = _OutboxFake()
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    sb.seed([_due_row(next_attempt_at=future)])

    res = await outbox_relay.run_outbox_relay_once(
        _settings(), handlers={("meta", "record_launch"): _ok_handler}, sb=sb
    )
    assert res.claimed == 0
    assert sb.row("ob-1")["status"] == "pending"  # never claimed


# ===========================================================================
# backoff + dead-letter
# ===========================================================================


async def test_handler_failure_backs_off_and_bumps_attempts() -> None:
    sb = _OutboxFake()
    sb.seed([_due_row(attempts=0)])

    async def boom(_req):  # noqa: ANN001, ANN202
        raise RuntimeError("meta 503")

    res = await outbox_relay.run_outbox_relay_once(
        _settings(scheduler_outbox_max_attempts=8),
        handlers={("meta", "record_launch"): boom},
        sb=sb,
    )
    assert res.retried == 1
    assert res.dead_lettered == 0
    row = sb.row("ob-1")
    assert row["status"] == "pending"  # backed off, recoverable next pass
    assert row["attempts"] == 1
    assert row["last_error"] == "meta 503"
    # next_attempt_at was pushed into the future (the backoff).
    nxt = datetime.fromisoformat(row["next_attempt_at"])
    assert nxt > datetime.now(timezone.utc)


async def test_dead_letters_after_max_attempts() -> None:
    sb = _OutboxFake()
    # attempts=7 -> this failure makes it 8 == max -> dead.
    sb.seed([_due_row(attempts=7)])

    async def boom(_req):  # noqa: ANN001, ANN202
        raise RuntimeError("still failing")

    res = await outbox_relay.run_outbox_relay_once(
        _settings(scheduler_outbox_max_attempts=8),
        handlers={("meta", "record_launch"): boom},
        sb=sb,
    )
    assert res.dead_lettered == 1
    assert res.retried == 0
    row = sb.row("ob-1")
    assert row["status"] == "dead"
    assert row["attempts"] == 8
    assert row["last_error"] == "still failing"


async def test_outbox_relay_error_dead_letters_immediately() -> None:
    sb = _OutboxFake()
    sb.seed([_due_row(attempts=0)])

    async def reject(_req):  # noqa: ANN001, ANN202
        raise OutboxRelayError("meta 400 will never accept this")

    res = await outbox_relay.run_outbox_relay_once(
        _settings(scheduler_outbox_max_attempts=8),
        handlers={("meta", "record_launch"): reject},
        sb=sb,
    )
    # Non-retryable: dead on the first attempt, no backoff.
    assert res.dead_lettered == 1
    row = sb.row("ob-1")
    assert row["status"] == "dead"
    assert row["attempts"] == 1


# ===========================================================================
# bounding, skipping, resilience, no-op
# ===========================================================================


async def test_pass_is_bounded() -> None:
    sb = _OutboxFake()
    sb.seed([_due_row(id=f"ob-{i}", idempotency_key=f"k-{i}") for i in range(5)])

    res = await outbox_relay.run_outbox_relay_once(
        _settings(scheduler_outbox_max_per_pass=2),
        handlers={("meta", "record_launch"): _ok_handler},
        sb=sb,
    )
    assert res.claimed == 2
    assert res.done == 2
    done = [r for r in sb.store if r["status"] == "done"]
    assert len(done) == 2


async def test_unhandled_op_is_skipped_not_burned() -> None:
    sb = _OutboxFake()
    sb.seed([_due_row(integration="slack", op="unknown", attempts=0)])

    res = await outbox_relay.run_outbox_relay_once(
        _settings(), handlers={("meta", "record_launch"): _ok_handler}, sb=sb
    )
    assert res.skipped == 1
    assert res.done == 0
    row = sb.row("ob-1")
    # Claimed (inflight) but attempts NOT burned -- a later deploy's handler can
    # still pick it up; the observability watchdog flags it if it lingers.
    assert row["attempts"] == 0
    assert row["status"] == "inflight"


async def test_one_bad_row_never_aborts_the_sweep() -> None:
    sb = _OutboxFake()
    sb.seed(
        [
            _due_row(id="ob-bad", idempotency_key="k-bad"),
            _due_row(id="ob-good", idempotency_key="k-good"),
        ]
    )

    # A handler that fails exactly once (the first row handled) -- the second
    # row must still drain, proving one bad row never aborts the pass.
    state = {"failed_once": False}

    async def handler(_req):  # noqa: ANN001, ANN202
        if not state["failed_once"]:
            state["failed_once"] = True
            raise RuntimeError("boom")
        return {"ok": True}

    res = await outbox_relay.run_outbox_relay_once(
        _settings(), handlers={("meta", "record_launch"): handler}, sb=sb
    )
    # Both claimed; one failed (retry) one done -- the sweep didn't abort.
    assert res.claimed == 2
    assert res.done >= 1
    assert (res.retried + res.dead_lettered) >= 1


async def test_empty_due_set_is_noop() -> None:
    sb = _OutboxFake()
    res = await outbox_relay.run_outbox_relay_once(
        _settings(), handlers={("meta", "record_launch"): _ok_handler}, sb=sb
    )
    assert res == outbox_relay.OutboxPassResult(0, 0, 0, 0, 0)


# ===========================================================================
# claim paths: SKIP-LOCKED RPC fast path vs REST fallback
# ===========================================================================


async def test_rest_fallback_used_when_rpc_absent() -> None:
    sb = _OutboxFake(rpc_unavailable=True)
    sb.seed([_due_row()])
    res = await outbox_relay.run_outbox_relay_once(
        _settings(), handlers={("meta", "record_launch"): _ok_handler}, sb=sb
    )
    # The RPC was attempted (and failed -> fallback claimed the row via REST).
    assert sb.rpc_calls and sb.rpc_calls[0][0] == "claim_due_integration_outbox"
    assert res.done == 1


async def test_rpc_fast_path_claims_when_available() -> None:
    sb = _OutboxFake(rpc_unavailable=False)
    # The RPC returns the claimed rows directly (already inflight, server-side).
    sb.rpc_claim = [_due_row(status="inflight")]
    res = await outbox_relay.run_outbox_relay_once(
        _settings(), handlers={("meta", "record_launch"): _ok_handler}, sb=sb
    )
    assert sb.rpc_calls[0][0] == "claim_due_integration_outbox"
    assert res.claimed == 1
    assert res.done == 1


async def test_rest_guarded_claim_skips_lost_race(monkeypatch: pytest.MonkeyPatch) -> None:
    """A row already flipped out of 'pending' by a racing relay is not re-claimed."""
    sb = _OutboxFake(rpc_unavailable=True)
    # Two due rows; one will be 'stolen' (status no longer pending) before claim.
    sb.seed(
        [
            _due_row(id="ob-mine", idempotency_key="k-mine"),
            _due_row(id="ob-stolen", idempotency_key="k-stolen", status="inflight"),
        ]
    )
    # ob-stolen is already inflight, so the REST select (status='pending') never
    # returns it -- only ob-mine is claimable.
    res = await outbox_relay.run_outbox_relay_once(
        _settings(), handlers={("meta", "record_launch"): _ok_handler}, sb=sb
    )
    assert res.claimed == 1
    assert sb.row("ob-mine")["status"] == "done"
    assert sb.row("ob-stolen")["status"] == "inflight"  # untouched


async def test_rpc_returning_non_list_falls_back_to_rest() -> None:
    """A garbled RPC return (not a list) is treated as 'absent' -> REST claim."""
    sb = _OutboxFake(rpc_unavailable=False)
    sb.rpc_claim = {"unexpected": "shape"}  # not a list
    sb.seed([_due_row()])
    res = await outbox_relay.run_outbox_relay_once(
        _settings(), handlers={("meta", "record_launch"): _ok_handler}, sb=sb
    )
    assert res.done == 1  # REST fallback still drained the row


async def test_rpc_returning_none_falls_back_to_rest() -> None:
    sb = _OutboxFake(rpc_unavailable=False)
    sb.rpc_claim = None  # RPC present but returned no data
    sb.seed([_due_row()])
    res = await outbox_relay.run_outbox_relay_once(
        _settings(), handlers={("meta", "record_launch"): _ok_handler}, sb=sb
    )
    assert res.done == 1


async def test_rest_skips_row_without_id() -> None:
    """A malformed pending row (no id) is skipped, not crashed on."""
    sb = _OutboxFake(rpc_unavailable=True)
    # Seed a row then strip its id to simulate a malformed read.
    sb.seed([_due_row()])
    sb.store[0].pop("id", None)
    sb.store[0]["id"] = None
    res = await outbox_relay.run_outbox_relay_once(
        _settings(), handlers={("meta", "record_launch"): _ok_handler}, sb=sb
    )
    assert res.claimed == 0


# ===========================================================================
# _parse_ts (defensive timestamp parsing)
# ===========================================================================


def test_parse_ts_accepts_datetime_and_defaults_on_garbage() -> None:
    default = datetime(2026, 1, 1, tzinfo=timezone.utc)
    # A naive datetime is coerced to UTC.
    naive = datetime(2026, 5, 1, 12, 0, 0)
    assert outbox_relay._parse_ts(naive, default=default).tzinfo is timezone.utc
    # An aware datetime passes through.
    aware = datetime(2026, 5, 1, 12, 0, 0, tzinfo=timezone.utc)
    assert outbox_relay._parse_ts(aware, default=default) == aware
    # Empty / None / unparseable strings fall back to the default (due-now).
    assert outbox_relay._parse_ts("", default=default) == default
    assert outbox_relay._parse_ts(None, default=default) == default
    assert outbox_relay._parse_ts("not-a-timestamp", default=default) == default
    # A trailing-Z ISO string parses to aware UTC.
    parsed = outbox_relay._parse_ts("2026-05-01T12:00:00Z", default=default)
    assert parsed == datetime(2026, 5, 1, 12, 0, 0, tzinfo=timezone.utc)


async def test_default_handlers_are_no_op_shells() -> None:
    """The wired handlers acknowledge their request (idempotent follow-through)."""
    handlers = outbox_relay.default_handlers()
    meta = await handlers[("meta", "record_launch")](
        {"pipeline_id": "p-9", "entities": [{"id": "e1"}]}
    )
    assert meta == {"acknowledged": True, "pipeline_id": "p-9"}
    drive = await handlers[("drive", "finalize_verified")](
        {"pipeline_id": "p-9", "assets": [{"creative_id": "c1"}]}
    )
    assert drive == {"acknowledged": True, "pipeline_id": "p-9"}
