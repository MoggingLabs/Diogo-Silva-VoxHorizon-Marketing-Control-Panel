"""Per-brief sequential queue.

Image generation must be serial within a brief: the Kie.ai rate limits +
the visual-verify SOP both require we finish one PNG before starting the
next. Different briefs *can* run in parallel — this module gives us
exactly that property with a per-brief mutex.

Usage::

    async with get_queue().acquire(brief_id):
        # the Kie.ai call + visual verify happens here, serialized per
        # brief, parallel across briefs
        ...

Durability (E5.3 / #517)
------------------------
The mutex is backed by a DURABLE LEASE ROW in Postgres
(``brief_queue_locks``, migration 0038) claimed/released via the
``try_claim_brief_lock`` / ``release_brief_lock`` / ``heartbeat_brief_lock``
RPCs. A lease row -- rather than an in-memory ``asyncio.Lock`` or a
session advisory lock -- is the right primitive because:

* It survives a process restart and coordinates across *multiple* worker
  processes: a second process sees the live lease row and waits, instead
  of seeing an empty in-memory map and double-running the brief.
* It is owned by an opaque per-acquire token, not a database connection,
  so it is immune to PostgREST connection pooling (a session advisory
  lock could not be reliably released from a pooled-different backend).
* A crashed holder's lease has a visible ``expires_at`` and is reclaimed
  by the next claimant (stale-takeover) instead of wedging the brief.

The lease is acquired by *polling* ``try_claim_brief_lock`` with bounded
backoff (so the worker never holds a server-side connection open while it
waits) and a background heartbeat extends ``expires_at`` while the
critical section runs. On exit the lease is released by token.

In-memory fallback
------------------
When Supabase is not configured (local boots, unit tests that don't wire
a DB) or the RPCs are unavailable (migration 0038 not yet applied), the
queue transparently falls back to a process-local ``asyncio.Lock`` per
brief -- the previous v1 behaviour. This keeps the ``async with
get_queue().acquire(brief_id)`` ergonomics identical for every call site
and lets the route tests run without a database. The fallback is logged
once per brief so an accidental production fallback is visible.

Health endpoints can call :meth:`BriefQueue.depth`, ``all_depths``, or
``total_depth`` to surface current local contention.
"""

from __future__ import annotations

import asyncio
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import structlog


log = structlog.get_logger(__name__)


# Lease tuning. The TTL is the window after which a crashed holder's lock is
# reclaimable; the heartbeat keeps a live, long critical section from being
# reclaimed under it. Poll backoff bounds how often a waiter re-tries the claim.
_LEASE_TTL_S = 120.0
_HEARTBEAT_INTERVAL_S = 30.0
_POLL_BASE_S = 0.05
_POLL_MAX_S = 2.0

# RPC names (migration 0038).
_RPC_CLAIM = "try_claim_brief_lock"
_RPC_RELEASE = "release_brief_lock"
_RPC_HEARTBEAT = "heartbeat_brief_lock"


def _supabase_admin_or_none() -> Any | None:
    """Return the service-role Supabase client, or ``None`` when unconfigured.

    Imported lazily so this module stays importable (and the in-memory
    fallback usable) when Supabase env vars are absent -- the same
    contract :mod:`supabase_client` documents for boot without Supabase.
    """
    try:
        from ..supabase_client import get_supabase_admin

        return get_supabase_admin()
    except Exception:  # noqa: BLE001 -- unconfigured / import error -> fallback
        return None


class _LeaseUnavailable(Exception):
    """Raised internally when the lease RPCs are absent/errored on first claim.

    Signals :meth:`BriefQueue.acquire` to degrade to the in-memory lock rather
    than wedging the brief. Only the *first* claim attempt translates a
    transport error into this; once we own the lease, later RPC blips (release /
    heartbeat) are tolerated in place by the lease TTL.
    """


class BriefQueue:
    """A keyed mutex: only one acquirer per ``brief_id`` runs at a time.

    The lock is a durable Postgres lease (cross-process, restart-safe) with
    a transparent in-memory fallback when no database is wired. The depth
    counter is incremented when an acquirer starts waiting and decremented
    after the critical section exits, so ``depth(brief_id)`` reflects both
    running and queued work *in this process*.
    """

    def __init__(self) -> None:
        # In-memory fallback locks (also the contention surface for depth()).
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._depths: dict[str, int] = defaultdict(int)
        # Briefs we've already logged a fallback for (avoid log spam).
        self._fallback_logged: set[str] = set()

    # -- lease RPC plumbing (DB-backed path) ------------------------------

    def _rpc(self, sb: Any, fn: str, params: dict[str, Any]) -> Any:
        """Call an RPC and return its ``.data`` (or raise on transport error)."""
        resp = sb.rpc(fn, params).execute()
        return getattr(resp, "data", None) if resp is not None else None

    async def _try_claim(
        self, sb: Any, brief_id: str, token: str, *, first: bool = False
    ) -> bool:
        """One non-blocking claim attempt. Returns True iff the lease is ours.

        The migration-0038 RPC always returns a scalar boolean. On the *first*
        attempt anything that is NOT a real boolean -- a transport error (RPC
        absent / DB down) or a non-bool ``data`` (function missing, REST shim
        returning ``None``) -- is translated to :class:`_LeaseUnavailable` so
        :meth:`acquire` can degrade to the in-memory lock instead of polling a
        claim that can never succeed. Once we own the lease the loop is only
        entered after a successful ``first`` attempt has proven the RPC exists,
        so a later transient blip simply re-raises as a normal retry path.
        """
        try:
            data = await asyncio.to_thread(
                self._rpc,
                sb,
                _RPC_CLAIM,
                {
                    "p_brief_id": brief_id,
                    "p_owner_token": token,
                    "p_ttl_seconds": _LEASE_TTL_S,
                },
            )
        except Exception as e:  # noqa: BLE001 -- RPC absent / transport error
            if first:
                raise _LeaseUnavailable(str(e)) from e
            raise
        if not isinstance(data, bool):
            if first:
                raise _LeaseUnavailable(f"non-bool claim result: {data!r}")
            # A non-bool mid-poll is treated as "not ours" -- keep waiting.
            return False
        return data

    async def _release(self, sb: Any, brief_id: str, token: str) -> None:
        """Release the lease by token. Swallows transport errors -- the lease
        TTL is the backstop, so a failed release self-heals on expiry."""
        try:
            await asyncio.to_thread(
                self._rpc,
                sb,
                _RPC_RELEASE,
                {"p_brief_id": brief_id, "p_owner_token": token},
            )
        except Exception as e:  # noqa: BLE001
            log.warning(
                "brief_lock_release_failed", brief_id=brief_id, error=str(e)
            )

    async def _heartbeat_loop(self, sb: Any, brief_id: str, token: str) -> None:
        """Extend the lease while the critical section runs.

        Cancelled by the acquire() ``finally`` once the section exits. A
        heartbeat failure is logged but not fatal -- if the lease lapses the
        worst case is another claimant takes over a brief whose holder has
        gone quiet, which is the intended stale-takeover behaviour.
        """
        while True:
            await asyncio.sleep(_HEARTBEAT_INTERVAL_S)
            try:
                await asyncio.to_thread(
                    self._rpc,
                    sb,
                    _RPC_HEARTBEAT,
                    {
                        "p_brief_id": brief_id,
                        "p_owner_token": token,
                        "p_ttl_seconds": _LEASE_TTL_S,
                    },
                )
            except Exception as e:  # noqa: BLE001
                log.warning(
                    "brief_lock_heartbeat_failed", brief_id=brief_id, error=str(e)
                )

    @asynccontextmanager
    async def _acquire_lease(self, sb: Any, brief_id: str) -> AsyncIterator[None]:
        """Hold the durable lease for the duration of the ``async with``.

        Polls ``try_claim_brief_lock`` with bounded exponential backoff until
        the lease is ours, runs a heartbeat in the background, and releases by
        token on exit. The first claim is attempted eagerly so an uncontended
        brief incurs no poll delay.
        """
        token = str(uuid.uuid4())
        # First attempt translates a missing/broken RPC into _LeaseUnavailable
        # so acquire() can degrade; the polling loop then waits our turn.
        got = await self._try_claim(sb, brief_id, token, first=True)
        backoff = _POLL_BASE_S
        while not got:
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, _POLL_MAX_S)
            got = await self._try_claim(sb, brief_id, token)

        hb = asyncio.create_task(self._heartbeat_loop(sb, brief_id, token))
        try:
            yield
        finally:
            hb.cancel()
            try:
                await hb
            except asyncio.CancelledError:
                pass
            await self._release(sb, brief_id, token)

    def _log_fallback(self, brief_id: str, reason: str) -> None:
        if brief_id not in self._fallback_logged:
            self._fallback_logged.add(brief_id)
            log.warning(
                "brief_queue_in_memory_fallback", brief_id=brief_id, reason=reason
            )

    # -- public surface ---------------------------------------------------

    @asynccontextmanager
    async def acquire(self, brief_id: str) -> AsyncIterator[None]:
        """Hold the per-brief lock for the duration of the ``async with``.

        Prefers the durable Postgres lease; falls back to a process-local
        ``asyncio.Lock`` when Supabase is unconfigured or the lease RPCs are
        unavailable. The signature + ergonomics are identical in both modes so
        call sites never change.
        """
        # The depth counter tracks *local* contention regardless of mode so the
        # health endpoints keep reporting in-process waiters.
        self._depths[brief_id] += 1
        try:
            sb = _supabase_admin_or_none()
            if sb is None:
                self._log_fallback(brief_id, "supabase_unconfigured")
                async with self._locks[brief_id]:
                    yield
                return

            try:
                async with self._acquire_lease(sb, brief_id):
                    yield
                return
            except _LeaseUnavailable:
                # RPC missing / errored on the FIRST claim -> degrade to the
                # in-memory lock so the brief still serializes in-process.
                self._log_fallback(brief_id, "lease_rpc_unavailable")
                async with self._locks[brief_id]:
                    yield
                return
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
