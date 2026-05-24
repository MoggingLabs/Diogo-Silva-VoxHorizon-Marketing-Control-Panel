"""Tests for the per-brief sequential queue."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

import src.services.queue as queue_mod
from src.services.queue import BriefQueue, get_queue, reset_queue


# ---------------------------------------------------------------------------
# DB-backed lease double
# ---------------------------------------------------------------------------
#
# A small in-memory stand-in for the migration-0038 lease RPCs. It models the
# brief_queue_locks row store + the try_claim / release / heartbeat semantics so
# the DB-backed acquire() path (and its contention / restart behaviour) can be
# exercised without a real Postgres.


class _FakeLeaseDB:
    """In-memory model of brief_queue_locks + the 0038 lease RPCs.

    ``rpc(fn, params).execute().data`` returns the scalar boolean each RPC
    returns in production. ``now`` is settable so tests can expire a lease
    deterministically (stale-takeover). ``raise_on`` makes a named RPC raise to
    exercise the degrade-to-in-memory path.
    """

    def __init__(self) -> None:
        # brief_id -> {"owner_token", "expires_at"}
        self.locks: dict[str, dict[str, Any]] = {}
        self.now: datetime = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.raise_on: set[str] = set()
        self.calls: list[tuple[str, dict[str, Any]]] = []

    # -- supabase-py surface ---------------------------------------------
    def rpc(self, fn: str, params: dict[str, Any]) -> "_FakeRpcResult":
        self.calls.append((fn, dict(params)))
        if fn in self.raise_on:
            raise RuntimeError(f"rpc {fn} unavailable")
        if fn == "try_claim_brief_lock":
            return _FakeRpcResult(self._claim(params))
        if fn == "release_brief_lock":
            return _FakeRpcResult(self._release(params))
        if fn == "heartbeat_brief_lock":
            return _FakeRpcResult(self._heartbeat(params))
        raise AssertionError(f"unexpected rpc: {fn}")

    # -- lease semantics (mirror the SQL functions) ----------------------
    def _claim(self, params: dict[str, Any]) -> bool:
        brief = params["p_brief_id"]
        token = params["p_owner_token"]
        ttl = float(params["p_ttl_seconds"])
        existing = self.locks.get(brief)
        # A live holder blocks the claim; a missing / expired lease is taken.
        if existing is not None and existing["expires_at"] > self.now:
            return False
        self.locks[brief] = {
            "owner_token": token,
            "expires_at": self.now + timedelta(seconds=max(ttl, 1)),
        }
        return True

    def _release(self, params: dict[str, Any]) -> bool:
        brief = params["p_brief_id"]
        token = params["p_owner_token"]
        existing = self.locks.get(brief)
        if existing is not None and existing["owner_token"] == token:
            del self.locks[brief]
            return True
        return False

    def _heartbeat(self, params: dict[str, Any]) -> bool:
        brief = params["p_brief_id"]
        token = params["p_owner_token"]
        ttl = float(params["p_ttl_seconds"])
        existing = self.locks.get(brief)
        if existing is not None and existing["owner_token"] == token:
            existing["expires_at"] = self.now + timedelta(seconds=max(ttl, 1))
            return True
        return False


class _FakeRpcResult:
    def __init__(self, data: Any) -> None:
        self._data = data

    def execute(self) -> SimpleNamespace:
        return SimpleNamespace(data=self._data)


@pytest.fixture
def lease_db(monkeypatch: pytest.MonkeyPatch) -> _FakeLeaseDB:
    """Install the lease double as the queue's Supabase client + speed polling."""
    db = _FakeLeaseDB()
    monkeypatch.setattr(queue_mod, "_supabase_admin_or_none", lambda: db)
    # Tighten the poll + heartbeat cadence so contention tests run fast.
    monkeypatch.setattr(queue_mod, "_POLL_BASE_S", 0.01)
    monkeypatch.setattr(queue_mod, "_POLL_MAX_S", 0.02)
    monkeypatch.setattr(queue_mod, "_HEARTBEAT_INTERVAL_S", 0.02)
    return db


# ---------------------------------------------------------------------------
# Same-brief serialization
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_same_brief_acquires_serialize() -> None:
    """Two concurrent acquirers on the same brief must run one-after-the-other."""
    q = BriefQueue()
    log: list[str] = []

    async def worker(label: str, hold_s: float) -> None:
        async with q.acquire("brief-1"):
            log.append(f"start-{label}")
            await asyncio.sleep(hold_s)
            log.append(f"end-{label}")

    await asyncio.gather(worker("A", 0.05), worker("B", 0.05))

    # Whichever started first, its end must be logged before the other's start.
    assert log[0].startswith("start-")
    assert log[1].startswith("end-")
    assert log[2].startswith("start-")
    assert log[3].startswith("end-")
    # The two workers must be different (A finishes before B starts, or vice versa).
    first_label = log[0].split("-")[1]
    assert log[1] == f"end-{first_label}"
    other = "B" if first_label == "A" else "A"
    assert log[2] == f"start-{other}"


# ---------------------------------------------------------------------------
# Different briefs run concurrently
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_different_briefs_run_concurrently() -> None:
    """Two acquirers on different brief ids must overlap in time."""
    q = BriefQueue()
    started_a = asyncio.Event()
    started_b = asyncio.Event()
    proceed = asyncio.Event()

    async def worker(brief_id: str, started: asyncio.Event) -> None:
        async with q.acquire(brief_id):
            started.set()
            await proceed.wait()

    a = asyncio.create_task(worker("brief-A", started_a))
    b = asyncio.create_task(worker("brief-B", started_b))

    # Both should have entered their critical sections within a tight window.
    await asyncio.wait_for(started_a.wait(), timeout=1.0)
    await asyncio.wait_for(started_b.wait(), timeout=1.0)

    # Both depths reflect the in-flight work.
    assert q.depth("brief-A") == 1
    assert q.depth("brief-B") == 1
    assert q.total_depth() == 2
    assert q.all_depths() == {"brief-A": 1, "brief-B": 1}

    proceed.set()
    await asyncio.gather(a, b)


# ---------------------------------------------------------------------------
# Depth reporting
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_depth_reflects_waiters() -> None:
    """A second acquirer queued behind the first should bump depth to 2."""
    q = BriefQueue()
    inside_first = asyncio.Event()
    release_first = asyncio.Event()

    async def first() -> None:
        async with q.acquire("brief-X"):
            inside_first.set()
            await release_first.wait()

    async def second() -> None:
        async with q.acquire("brief-X"):
            pass

    t1 = asyncio.create_task(first())
    await asyncio.wait_for(inside_first.wait(), timeout=1.0)

    t2 = asyncio.create_task(second())
    # Give the event loop a chance to register t2 as a waiter.
    await asyncio.sleep(0.01)

    assert q.depth("brief-X") == 2
    assert q.total_depth() == 2

    release_first.set()
    await asyncio.gather(t1, t2)

    # All released — bookkeeping drops back to empty.
    assert q.depth("brief-X") == 0
    assert q.all_depths() == {}
    assert q.total_depth() == 0


@pytest.mark.asyncio
async def test_depth_zero_for_unknown_brief() -> None:
    q = BriefQueue()
    assert q.depth("never-seen") == 0
    # Reading depth must not allocate bookkeeping.
    assert q.all_depths() == {}


@pytest.mark.asyncio
async def test_depth_cleans_up_after_release() -> None:
    q = BriefQueue()
    async with q.acquire("brief-Z"):
        assert q.depth("brief-Z") == 1
    assert q.depth("brief-Z") == 0
    assert "brief-Z" not in q.all_depths()


# ---------------------------------------------------------------------------
# Singleton accessor
# ---------------------------------------------------------------------------


def test_get_queue_returns_same_instance() -> None:
    reset_queue()
    a = get_queue()
    b = get_queue()
    try:
        assert a is b
    finally:
        reset_queue()


def test_reset_queue_drops_singleton() -> None:
    reset_queue()
    a = get_queue()
    reset_queue()
    b = get_queue()
    try:
        assert a is not b
    finally:
        reset_queue()


# ===========================================================================
# DB-backed lease: the durable, cross-process, restart-safe claim (E5.3)
# ===========================================================================


@pytest.mark.asyncio
async def test_lease_acquire_release_round_trip(lease_db: _FakeLeaseDB) -> None:
    """A clean acquire takes the lease row and releases it on exit."""
    q = BriefQueue()
    async with q.acquire("brief-1"):
        # Inside the critical section the lease row exists.
        assert "brief-1" in lease_db.locks
        token = lease_db.locks["brief-1"]["owner_token"]
        assert token  # an opaque per-acquire token was recorded
    # After exit the lease is released (row deleted by token).
    assert "brief-1" not in lease_db.locks
    # The DB path was used (not the in-memory fallback).
    fns = [fn for fn, _ in lease_db.calls]
    assert "try_claim_brief_lock" in fns
    assert "release_brief_lock" in fns


@pytest.mark.asyncio
async def test_lease_same_brief_serializes(lease_db: _FakeLeaseDB) -> None:
    """Two acquirers on the same brief run one-after-the-other via the lease."""
    q = BriefQueue()
    log: list[str] = []

    async def worker(label: str) -> None:
        async with q.acquire("brief-1"):
            log.append(f"start-{label}")
            await asyncio.sleep(0.03)
            log.append(f"end-{label}")

    await asyncio.gather(worker("A"), worker("B"))

    # Strict interleave: the first holder fully finishes before the second
    # starts -- the lease blocked the contender until release.
    assert log[0].startswith("start-")
    assert log[1].startswith("end-")
    assert log[2].startswith("start-")
    assert log[3].startswith("end-")
    first = log[0].split("-")[1]
    assert log[1] == f"end-{first}"


@pytest.mark.asyncio
async def test_lease_different_briefs_run_concurrently(
    lease_db: _FakeLeaseDB,
) -> None:
    """Different brief ids take independent lease rows and overlap in time."""
    q = BriefQueue()
    started_a = asyncio.Event()
    started_b = asyncio.Event()
    proceed = asyncio.Event()

    async def worker(brief_id: str, started: asyncio.Event) -> None:
        async with q.acquire(brief_id):
            started.set()
            await proceed.wait()

    a = asyncio.create_task(worker("brief-A", started_a))
    b = asyncio.create_task(worker("brief-B", started_b))

    await asyncio.wait_for(started_a.wait(), timeout=1.0)
    await asyncio.wait_for(started_b.wait(), timeout=1.0)

    # Both hold their own lease row simultaneously.
    assert set(lease_db.locks) == {"brief-A", "brief-B"}

    proceed.set()
    await asyncio.gather(a, b)
    assert lease_db.locks == {}


@pytest.mark.asyncio
async def test_lease_contention_waiter_takes_over_after_release(
    lease_db: _FakeLeaseDB,
) -> None:
    """A second acquirer blocks while the first holds, then claims on release."""
    q = BriefQueue()
    first_in = asyncio.Event()
    release_first = asyncio.Event()
    second_in = asyncio.Event()

    async def first() -> None:
        async with q.acquire("brief-X"):
            first_in.set()
            await release_first.wait()

    async def second() -> None:
        async with q.acquire("brief-X"):
            second_in.set()

    t1 = asyncio.create_task(first())
    await asyncio.wait_for(first_in.wait(), timeout=1.0)

    t2 = asyncio.create_task(second())
    # While first holds the lease, second must NOT have entered.
    await asyncio.sleep(0.05)
    assert not second_in.is_set()
    # The contender is polling try_claim repeatedly while it waits its turn.
    claim_calls = [fn for fn, _ in lease_db.calls if fn == "try_claim_brief_lock"]
    assert len(claim_calls) >= 2

    release_first.set()
    await asyncio.wait_for(t1, timeout=1.0)
    await asyncio.wait_for(second_in.wait(), timeout=1.0)
    await asyncio.wait_for(t2, timeout=1.0)
    assert lease_db.locks == {}


@pytest.mark.asyncio
async def test_lease_restart_safety_lease_survives_queue_instance(
    lease_db: _FakeLeaseDB,
) -> None:
    """A lease held in the DB blocks a BRAND-NEW BriefQueue instance.

    This is the property the in-memory lock could not provide: simulate a
    process restart by constructing a fresh BriefQueue (empty in-memory state)
    while a lease row still exists -- the new instance must wait, not double-run.
    """
    # Simulate a prior holder that crashed without releasing: a live lease row
    # exists but no Python object holds it.
    lease_db.locks["brief-R"] = {
        "owner_token": "ghost-holder",
        "expires_at": lease_db.now + timedelta(seconds=120),
    }

    q_after_restart = BriefQueue()  # fresh process: empty in-memory maps
    entered = asyncio.Event()

    async def attempt() -> None:
        async with q_after_restart.acquire("brief-R"):
            entered.set()

    task = asyncio.create_task(attempt())
    # The live lease blocks the new instance: it must not enter.
    await asyncio.sleep(0.05)
    assert not entered.is_set()

    # The ghost holder's lease expires (or is released); the new instance claims.
    del lease_db.locks["brief-R"]
    await asyncio.wait_for(entered.wait(), timeout=1.0)
    await asyncio.wait_for(task, timeout=1.0)


@pytest.mark.asyncio
async def test_lease_stale_takeover_after_expiry(lease_db: _FakeLeaseDB) -> None:
    """An expired lease (crashed holder) is reclaimed by the next claimant."""
    # Seed an EXPIRED lease from a crashed holder.
    lease_db.locks["brief-S"] = {
        "owner_token": "dead-holder",
        "expires_at": lease_db.now - timedelta(seconds=1),
    }
    q = BriefQueue()
    async with q.acquire("brief-S"):
        # The stale lease was taken over: a NEW owner token now holds it.
        assert lease_db.locks["brief-S"]["owner_token"] != "dead-holder"
    assert "brief-S" not in lease_db.locks


@pytest.mark.asyncio
async def test_lease_heartbeat_extends_expiry(
    lease_db: _FakeLeaseDB,
) -> None:
    """A long critical section is kept alive by the background heartbeat."""
    q = BriefQueue()
    async with q.acquire("brief-H"):
        first_expiry = lease_db.locks["brief-H"]["expires_at"]
        # Advance "now" so a heartbeat extends expires_at to a later instant.
        lease_db.now += timedelta(seconds=5)
        # Wait (bounded) until at least one heartbeat tick has fired.
        for _ in range(200):
            await asyncio.sleep(0.01)
            if any(fn == "heartbeat_brief_lock" for fn, _ in lease_db.calls):
                break
        # The heartbeat RPC was actually invoked while we held the lease.
        assert any(fn == "heartbeat_brief_lock" for fn, _ in lease_db.calls)
        # ...and it pushed the expiry past the original.
        assert lease_db.locks["brief-H"]["expires_at"] > first_expiry


@pytest.mark.asyncio
async def test_lease_release_failure_is_swallowed(
    lease_db: _FakeLeaseDB,
) -> None:
    """A release RPC error must not propagate out of acquire().

    The lease TTL is the backstop -- a failed release self-heals on expiry, so
    the context manager exit stays clean.
    """
    q = BriefQueue()
    async with q.acquire("brief-RF"):
        lease_db.raise_on.add("release_brief_lock")
    # No exception escaped; the (now un-released) row simply expires later.
    assert True


# ---------------------------------------------------------------------------
# Degrade-to-in-memory when the lease RPCs are unavailable
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_degrades_to_in_memory_when_rpc_errors(
    lease_db: _FakeLeaseDB,
) -> None:
    """If the first claim RPC raises, acquire() falls back to the local lock."""
    lease_db.raise_on.add("try_claim_brief_lock")
    q = BriefQueue()
    log: list[str] = []

    async def worker(label: str) -> None:
        async with q.acquire("brief-D"):
            log.append(f"start-{label}")
            await asyncio.sleep(0.02)
            log.append(f"end-{label}")

    # Still serializes in-process via the asyncio.Lock fallback.
    await asyncio.gather(worker("A"), worker("B"))
    assert log[1].startswith("end-")
    assert log[2].startswith("start-")
    # No lease row was ever created (the RPC errored before taking one).
    assert lease_db.locks == {}


@pytest.mark.asyncio
async def test_degrades_to_in_memory_when_rpc_returns_non_bool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A claim RPC that returns a non-bool (function absent) degrades cleanly."""

    class _NonBoolDB:
        def rpc(self, fn: str, params: dict[str, Any]) -> _FakeRpcResult:
            # PostgREST shim / missing function -> data is None, not a bool.
            return _FakeRpcResult(None)

    monkeypatch.setattr(queue_mod, "_supabase_admin_or_none", lambda: _NonBoolDB())
    q = BriefQueue()
    # Must not hang polling a claim that can never return True; the in-memory
    # fallback lets the section run to completion.
    async with q.acquire("brief-NB"):
        pass
    assert q.depth("brief-NB") == 0


@pytest.mark.asyncio
async def test_falls_back_to_in_memory_when_supabase_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No Supabase client => the previous v1 in-memory lock behaviour."""
    monkeypatch.setattr(queue_mod, "_supabase_admin_or_none", lambda: None)
    q = BriefQueue()
    async with q.acquire("brief-U"):
        assert q.depth("brief-U") == 1
    assert q.depth("brief-U") == 0


@pytest.mark.asyncio
async def test_depth_tracks_local_contention_on_lease_path(
    lease_db: _FakeLeaseDB,
) -> None:
    """depth() reflects in-process waiters even when the DB lease is in use."""
    q = BriefQueue()
    inside = asyncio.Event()
    release = asyncio.Event()

    async def holder() -> None:
        async with q.acquire("brief-DC"):
            inside.set()
            await release.wait()

    t1 = asyncio.create_task(holder())
    await asyncio.wait_for(inside.wait(), timeout=1.0)

    async def waiter() -> None:
        async with q.acquire("brief-DC"):
            pass

    t2 = asyncio.create_task(waiter())
    await asyncio.sleep(0.03)
    # Both the holder and the polling waiter are counted locally.
    assert q.depth("brief-DC") == 2

    release.set()
    await asyncio.gather(t1, t2)
    assert q.depth("brief-DC") == 0
    assert q.all_depths() == {}


def test_supabase_admin_or_none_returns_none_when_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The helper swallows the RuntimeError get_supabase_admin raises when the
    Supabase env vars are absent, so acquire() can degrade rather than crash."""
    import src.supabase_client as sc

    def _boom() -> Any:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY must be set")

    monkeypatch.setattr(sc, "get_supabase_admin", _boom)
    assert queue_mod._supabase_admin_or_none() is None


# ---------------------------------------------------------------------------
# Mid-poll resilience: once we own a turn in the loop, a transient blip on a
# *non-first* claim re-raises (no silent degrade) and a non-bool answer is
# treated as "not ours -> keep waiting".
# ---------------------------------------------------------------------------


class _ScriptedClaimDB:
    """Drives a scripted sequence of try_claim_brief_lock results.

    Each entry is either a bool (the claim answer) or an Exception instance to
    raise. release / heartbeat are inert no-ops returning True.
    """

    def __init__(self, claim_results: list[Any]) -> None:
        self._claim_results = list(claim_results)
        self.calls: list[str] = []

    def rpc(self, fn: str, params: dict[str, Any]) -> _FakeRpcResult:
        self.calls.append(fn)
        if fn == "try_claim_brief_lock":
            nxt = self._claim_results.pop(0)
            if isinstance(nxt, Exception):
                raise nxt
            return _FakeRpcResult(nxt)
        return _FakeRpcResult(True)


@pytest.mark.asyncio
async def test_mid_poll_claim_error_propagates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A transport error on a NON-first claim re-raises (line 156).

    The first claim proved the RPC exists (returned a real ``False``), so a
    later blip is a genuine failure, not a "degrade" signal.
    """
    db = _ScriptedClaimDB([False, RuntimeError("blip mid-poll")])
    monkeypatch.setattr(queue_mod, "_supabase_admin_or_none", lambda: db)
    monkeypatch.setattr(queue_mod, "_POLL_BASE_S", 0.001)
    monkeypatch.setattr(queue_mod, "_POLL_MAX_S", 0.001)
    q = BriefQueue()
    with pytest.raises(RuntimeError, match="blip mid-poll"):
        async with q.acquire("brief-MP"):
            pass


@pytest.mark.asyncio
async def test_mid_poll_non_bool_keeps_waiting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A non-bool answer mid-poll is treated as 'not ours' and we keep polling
    until a real True lands (line 161)."""
    db = _ScriptedClaimDB([False, None, True])
    monkeypatch.setattr(queue_mod, "_supabase_admin_or_none", lambda: db)
    monkeypatch.setattr(queue_mod, "_POLL_BASE_S", 0.001)
    monkeypatch.setattr(queue_mod, "_POLL_MAX_S", 0.001)
    q = BriefQueue()
    async with q.acquire("brief-NB2"):
        pass
    # First False + None (ignored) + True => 3 claim attempts.
    assert db.calls.count("try_claim_brief_lock") == 3


@pytest.mark.asyncio
async def test_heartbeat_rpc_failure_is_swallowed(
    lease_db: _FakeLeaseDB,
) -> None:
    """A heartbeat RPC error is logged, not fatal (line 201)."""
    lease_db.raise_on.add("heartbeat_brief_lock")
    q = BriefQueue()
    async with q.acquire("brief-HB"):
        # Give the heartbeat loop time to tick (and fail) at least once.
        for _ in range(200):
            await asyncio.sleep(0.01)
            if any(fn == "heartbeat_brief_lock" for fn, _ in lease_db.calls):
                break
        assert any(fn == "heartbeat_brief_lock" for fn, _ in lease_db.calls)
    # acquire() exited cleanly despite the heartbeat failures.
    assert "brief-HB" not in lease_db.locks
