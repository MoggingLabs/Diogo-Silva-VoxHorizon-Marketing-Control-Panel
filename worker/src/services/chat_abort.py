"""In-memory abort-flag store for streaming chat sessions.

The chat-with-Ekko SSE stream runs inside a single worker process and is
the only consumer of these flags, so an in-process registry is enough —
no Redis, no DB row. The Next.js abort endpoint POSTs to the worker
which flips a flag here; the streaming coroutine polls the flag at safe
checkpoints (between chunks) and exits cleanly when it sees the abort.

Key shape: ``{kind}:{creative_id}`` (e.g. ``image:abc-123``). The
``ChatAbortStore`` is intentionally small — just ``request``,
``is_aborted``, and ``clear`` — so tests can monkey-patch with a fake
without re-implementing the interface.

Concurrency note: FastAPI runs each request in a coroutine on the same
loop. The store uses plain ``dict`` access without locking; the GIL +
the single-threaded event loop give us atomicity for ``__setitem__``
and ``__contains__``. If the worker ever moves to a worker pool we'll
switch to ``asyncio.Lock`` here.
"""

from __future__ import annotations

import time
from typing import Literal


ChatKind = Literal["image", "video"]


class ChatAbortStore:
    """Track which (kind, creative_id) chat sessions have been aborted.

    The store survives for the lifetime of the worker process. Flags
    auto-expire after ``ttl_seconds`` so a stale POST can't accidentally
    abort a future session that re-uses the same creative_id.
    """

    DEFAULT_TTL_SECONDS = 60.0

    def __init__(self, *, ttl_seconds: float | None = None) -> None:
        self._ttl = ttl_seconds if ttl_seconds is not None else self.DEFAULT_TTL_SECONDS
        # Map composite key -> wall-clock seconds when the flag was set.
        self._flags: dict[str, float] = {}

    @staticmethod
    def make_key(kind: ChatKind, creative_id: str) -> str:
        return f"{kind}:{creative_id}"

    def request(self, kind: ChatKind, creative_id: str) -> None:
        """Stamp an abort request for the given session.

        Idempotent — repeat calls just refresh the timestamp.
        """
        self._flags[self.make_key(kind, creative_id)] = time.monotonic()

    def is_aborted(self, kind: ChatKind, creative_id: str) -> bool:
        """Return True iff there is a fresh (non-expired) abort flag.

        Expired flags are pruned lazily so the dict doesn't grow without
        bound on a long-running worker.
        """
        key = self.make_key(kind, creative_id)
        stamp = self._flags.get(key)
        if stamp is None:
            return False
        if (time.monotonic() - stamp) > self._ttl:
            # Stale flag — clean it up and pretend we never saw it.
            self._flags.pop(key, None)
            return False
        return True

    def clear(self, kind: ChatKind, creative_id: str) -> None:
        """Drop the flag for one session. Called when a stream finishes."""
        self._flags.pop(self.make_key(kind, creative_id), None)

    def clear_all(self) -> None:
        """Drop every flag (test helper)."""
        self._flags.clear()


# Module-level singleton. Routes get the store via :func:`get_store` so
# tests can substitute an instance without monkey-patching imports.
_store: ChatAbortStore | None = None


def get_store() -> ChatAbortStore:
    global _store
    if _store is None:
        _store = ChatAbortStore()
    return _store


def _reset_store() -> None:
    """Test helper — drop the singleton so the next call re-creates it."""
    global _store
    _store = None
