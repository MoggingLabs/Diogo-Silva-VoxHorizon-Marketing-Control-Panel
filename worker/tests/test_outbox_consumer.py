"""Unit tests for :mod:`services.outbox_consumer` (silent-failure PR-4).

The outbox consumer is the replacement for the deleted ``outbox_relay`` -- it
drains ``work_item`` rows of the outbox-* kinds (claim -> handler -> close),
while the unified watchdog owns retry/dead-letter. These tests pin the
contract against the in-memory FakeSupabase double:

  * happy path -- a queued row is claimed, the handler runs, the row is
    PATCHed to ``completed`` with the token cleared;
  * handler raises -- the row is left held (the watchdog rotates it);
  * claim_token rotated mid-handler -- the close hits 0 rows and is logged +
    skipped (the watchdog already requeued);
  * empty queue -- the pass reports zero per kind and writes nothing;
  * unknown kind in the registered set -- logged + skipped.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from src.config import Settings
from src.services import outbox_consumer
from src.services.outbox_consumer import (
    _HANDLERS,
    run_outbox_drain_once,
)


# All four outbox-* kinds the producers enqueue + the consumer drains. Keep in
# sync with the wired set in scheduler.start_scheduler.
_KINDS = [
    "outbox_meta_record_launch",
    "outbox_drive_finalize_verified",
    "outbox_ghl_send",
]


def _settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = dict(
        worker_shared_secret="test",
        outbox_max_attempts=5,
        scheduler_outbox_drain_interval_s=5,
    )
    base.update(overrides)
    return Settings(**base)  # type: ignore[call-arg]


def _claim_row(
    kind: str,
    *,
    work_item_id: str = "wi-1",
    claim_token: str = "tok-1",
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": work_item_id,
        "kind": kind,
        "status": "claimed",
        "claim_token": claim_token,
        "claimed_by": "outbox-worker-test",
        "claimed_at": "2026-05-27T00:00:00+00:00",
        "attempt": 1,
        "payload": payload or {"pipeline_id": "p-1"},
        "pipeline_id": "p-1",
    }


class _SingleClaimSb:
    """A fake supabase client that returns one claimable row on the first RPC.

    Wraps a real FakeSupabase so the rest of the surface (table().update().eq()
    etc.) behaves normally; only the rpc('claim_work_item', ...) call is
    intercepted to serve the pre-seeded row exactly once per kind.
    """

    def __init__(self, base: Any, *, claims: dict[str, list[dict[str, Any]]]) -> None:
        self._base = base
        self._claims = {k: list(v) for k, v in claims.items()}
        # Forward attributes used by tests / facade.
        self.rpc_calls: list[tuple[str, dict[str, Any]]] = []

    def table(self, name: str) -> Any:
        return self._base.table(name)

    def rpc(self, fn: str, params: dict[str, Any]) -> Any:
        self.rpc_calls.append((fn, dict(params)))
        if fn != "claim_work_item":
            return self._base.rpc(fn, params)

        kind = params.get("p_kind")
        queue = self._claims.get(str(kind) or "", [])

        class _Resp:
            def __init__(self, data: Any) -> None:
                self._data = data

            def execute(self) -> Any:
                from types import SimpleNamespace

                return SimpleNamespace(data=self._data)

        if not queue:
            return _Resp(None)
        row = queue.pop(0)
        return _Resp(row)

    @property
    def inserts(self) -> list[tuple[str, dict[str, Any]]]:
        return self._base.inserts

    @property
    def updates(self) -> list[tuple[str, dict[str, Any]]]:
        return self._base.updates


def test_drain_no_due_rows_reports_zero_per_kind(fake_supabase) -> None:
    """Empty queues for every kind -> the tally is zero for each, no writes."""
    sb = _SingleClaimSb(fake_supabase, claims={k: [] for k in _KINDS})
    tally = asyncio.run(
        run_outbox_drain_once(_settings(), kinds=_KINDS, sb=sb)
    )
    assert tally == {k: 0 for k in _KINDS}
    assert fake_supabase.updates == []
    assert fake_supabase.inserts == []


def test_drain_happy_completes_meta_row(fake_supabase) -> None:
    """A claimed meta-launch row runs its handler + is PATCHed completed."""
    row = _claim_row("outbox_meta_record_launch", payload={"pipeline_id": "p-7"})
    sb = _SingleClaimSb(
        fake_supabase,
        claims={
            "outbox_meta_record_launch": [row],
            "outbox_drive_finalize_verified": [],
            "outbox_ghl_send": [],
        },
    )
    tally = asyncio.run(
        run_outbox_drain_once(_settings(), kinds=_KINDS, sb=sb)
    )
    assert tally["outbox_meta_record_launch"] == 1
    assert tally["outbox_drive_finalize_verified"] == 0
    # The row was closed via token-scoped UPDATE.
    closes = [u for n, u in fake_supabase.updates if n == "work_item"]
    assert closes and closes[-1]["status"] == "completed"
    assert closes[-1]["claim_token"] is None
    assert closes[-1]["result"]["pipeline_id"] == "p-7"


def test_drain_handler_raise_leaves_row_held(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A handler that raises must NOT close the row (watchdog owns retry)."""

    async def _boom(sb: Any, payload: Any) -> Any:
        raise RuntimeError("handler exploded")

    monkeypatch.setitem(_HANDLERS, "outbox_meta_record_launch", _boom)
    row = _claim_row("outbox_meta_record_launch")
    sb = _SingleClaimSb(
        fake_supabase,
        claims={
            "outbox_meta_record_launch": [row],
            "outbox_drive_finalize_verified": [],
            "outbox_ghl_send": [],
        },
    )
    tally = asyncio.run(
        run_outbox_drain_once(_settings(), kinds=_KINDS, sb=sb)
    )
    # No completion, no failure write -- the row stays held; watchdog rotates.
    assert tally["outbox_meta_record_launch"] == 0
    closes = [u for n, u in fake_supabase.updates if n == "work_item"]
    assert closes == []


def test_drain_close_token_rotated_is_logged_skip(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An UPDATE that hits 0 rows (token rotated mid-handler) is a logged skip."""
    row = _claim_row("outbox_drive_finalize_verified")
    sb = _SingleClaimSb(
        fake_supabase,
        claims={
            "outbox_meta_record_launch": [],
            "outbox_drive_finalize_verified": [row],
            "outbox_ghl_send": [],
        },
    )

    # Patch the facade's complete to return False (simulating a 0-row UPDATE).
    from src.services import work_queue

    monkeypatch.setattr(work_queue, "complete_work_item", lambda *a, **kw: False)

    tally = asyncio.run(
        run_outbox_drain_once(_settings(), kinds=_KINDS, sb=sb)
    )
    assert tally["outbox_drive_finalize_verified"] == 0


def test_drain_unknown_kind_is_logged_skip(fake_supabase) -> None:
    """A kind without a registered handler is a logged skip, not a crash."""
    sb = _SingleClaimSb(fake_supabase, claims={"made_up_kind": []})
    tally = asyncio.run(
        run_outbox_drain_once(_settings(), kinds=["made_up_kind"], sb=sb)
    )
    assert tally == {"made_up_kind": 0}


def test_drain_claim_failure_is_logged_skip(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A claim error for one kind never aborts the rest of the pass."""

    def _boom(sb: Any, *, kind: str, consumer: str) -> Any:
        if kind == "outbox_meta_record_launch":
            raise RuntimeError("claim exploded")
        return None

    from src.services import work_queue

    monkeypatch.setattr(work_queue, "claim_work_item", _boom)

    tally = asyncio.run(
        run_outbox_drain_once(_settings(), kinds=_KINDS, sb=fake_supabase)
    )
    # The bad kind reports 0 (claim raised), the others ran their (empty) pass.
    assert tally["outbox_meta_record_launch"] == 0
    assert tally["outbox_drive_finalize_verified"] == 0


def test_drain_handler_for_drive_returns_ack(fake_supabase) -> None:
    """The drive handler returns an acknowledged result that is recorded."""
    row = _claim_row(
        "outbox_drive_finalize_verified",
        payload={"pipeline_id": "p-9", "assets": [{"creative_id": "c-1"}]},
    )
    sb = _SingleClaimSb(
        fake_supabase,
        claims={
            "outbox_meta_record_launch": [],
            "outbox_drive_finalize_verified": [row],
            "outbox_ghl_send": [],
        },
    )
    tally = asyncio.run(
        run_outbox_drain_once(_settings(), kinds=_KINDS, sb=sb)
    )
    assert tally["outbox_drive_finalize_verified"] == 1
    closes = [u for n, u in fake_supabase.updates if n == "work_item"]
    assert closes[-1]["status"] == "completed"
    assert closes[-1]["result"]["pipeline_id"] == "p-9"


def test_drain_handlers_are_registered_for_all_three_kinds() -> None:
    """The wired handler table covers every outbox kind the scheduler drains."""
    for kind in _KINDS:
        assert kind in _HANDLERS


def test_drain_ghl_send_handler_acknowledges(fake_supabase) -> None:
    """The GHL handler is a no-op shell that acknowledges the row."""
    row = _claim_row("outbox_ghl_send", payload={"pipeline_id": "p-ghl"})
    sb = _SingleClaimSb(
        fake_supabase,
        claims={
            "outbox_meta_record_launch": [],
            "outbox_drive_finalize_verified": [],
            "outbox_ghl_send": [row],
        },
    )
    tally = asyncio.run(
        run_outbox_drain_once(_settings(), kinds=_KINDS, sb=sb)
    )
    assert tally["outbox_ghl_send"] == 1
