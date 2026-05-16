"""Tests for the per-brief sequential queue."""

from __future__ import annotations

import asyncio

import pytest

from src.services.queue import BriefQueue, get_queue, reset_queue


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
