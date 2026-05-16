"""Per-brief sequential queue.

Image generation must be serial within a brief: the Kie.ai rate limits +
the visual-verify SOP both require we finish one PNG before starting the
next. Different briefs *can* run in parallel — this module gives us
exactly that property with a per-brief asyncio mutex.

Usage::

    async with get_queue().acquire(brief_id):
        # the Kie.ai call + visual verify happens here, serialized per
        # brief, parallel across briefs
        ...

Health endpoints can call :meth:`BriefQueue.depth`, ``all_depths``, or
``total_depth`` to surface current contention.

For v1 (single-process FastAPI on a single host) ``asyncio.Lock`` is
sufficient. If we ever scale beyond one worker process this needs to move
to Redis / Postgres advisory locks / Kafka — and the in-memory state
resets on every process restart, which is acceptable for now because a
restart implies all in-flight jobs are already lost anyway.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import AsyncIterator


class BriefQueue:
    """A keyed mutex: only one acquirer per ``brief_id`` runs at a time.

    The depth counter is incremented when an acquirer starts waiting and
    decremented after the critical section exits, so ``depth(brief_id)``
    reflects both running and queued work.
    """

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._depths: dict[str, int] = defaultdict(int)

    @asynccontextmanager
    async def acquire(self, brief_id: str) -> AsyncIterator[None]:
        """Hold the per-brief lock for the duration of the ``async with``."""
        self._depths[brief_id] += 1
        try:
            async with self._locks[brief_id]:
                yield
        finally:
            self._depths[brief_id] -= 1
            if self._depths[brief_id] <= 0:
                # Drop the bookkeeping entries so an idle queue
                # returns an empty mapping.
                self._depths.pop(brief_id, None)
                self._locks.pop(brief_id, None)

    def depth(self, brief_id: str) -> int:
        """Return the number of acquirers (running + queued) for a brief."""
        return self._depths.get(brief_id, 0)

    def all_depths(self) -> dict[str, int]:
        """Return a snapshot of depths keyed by brief id."""
        return dict(self._depths)

    def total_depth(self) -> int:
        """Sum of all per-brief depths."""
        return sum(self._depths.values())


# Singleton — wired in `main.create_app`. Tests should bypass this by
# constructing their own `BriefQueue` instance.
_singleton: BriefQueue | None = None


def get_queue() -> BriefQueue:
    """Return the process-wide :class:`BriefQueue` singleton."""
    global _singleton
    if _singleton is None:
        _singleton = BriefQueue()
    return _singleton


def reset_queue() -> None:
    """Drop the singleton so the next ``get_queue()`` call rebuilds it.

    Tests use this to isolate queue state between cases.
    """
    global _singleton
    _singleton = None
