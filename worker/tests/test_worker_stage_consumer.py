"""Unit tests for :mod:`services.worker_stage_consumer` (silent-failure PR-8).

The worker-stage consumer is the missing claimant for the deterministic
``worker_ideation`` / ``worker_generation`` work_item kinds (the PR-3 cutover
removed the routes' fire-and-forget HTTP kicks but never built a consumer, so
those rows sat ``queued`` forever). These tests pin the contract against the
in-memory FakeSupabase double + a stubbed stage handler:

  * happy path -- a queued row per kind is claimed, transitioned to ``running``
    under a heartbeat, the handler runs, the row is PATCHed ``completed`` with
    the claim cleared;
  * the handler raises an UNEXPECTED fault -> the row is closed ``failed`` with a
    classified ``error_kind`` (retryable -> watchdog rotates; terminal ->
    dead-letter);
  * the initial claim->running heartbeat hits 0 rows (watchdog rotated us
    between claim and first beat) -> no dispatch, no close;
  * a token rotation observed by the heartbeat task mid-run -> the row is NOT
    closed (the watchdog owns it now);
  * the terminal complete hits 0 rows (token rotated) -> logged skip;
  * no due row -> no-op, zero tally, no writes;
  * an unknown kind in the requested set -> logged skip.

The real ideation/generation orchestration is exercised end-to-end by the e2e
suite (the consumer runs in the CI worker); here we stub the per-kind handler so
the claim/heartbeat/close lifecycle is isolated and deterministic.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from src.config import Settings
from src.services import work_queue, worker_stage_consumer
from src.services.worker_stage_consumer import (
    _HANDLERS,
    _already_terminal_good,
    _classify_failure,
    _handle_worker_compliance,
    _handle_worker_generation,
    _handle_worker_ideation,
    _handle_worker_monitor,
    _handle_worker_qa,
    _handle_worker_spec,
    _resolve_in_scope_creatives,
    run_worker_stage_drain_once,
)


_KINDS = ["worker_ideation", "worker_generation"]


def _settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = dict(
        worker_shared_secret="test",
        # A tiny heartbeat interval keeps the (cancelled-immediately) heartbeat
        # task from sleeping the whole test; the happy path cancels it before
        # the first sleep elapses anyway.
        work_item_consumer_heartbeat_s=1,
        scheduler_worker_stage_interval_s=5,
    )
    base.update(overrides)
    return Settings(**base)  # type: ignore[call-arg]


def _claim_row(
    kind: str,
    *,
    work_item_id: str = "wi-1",
    claim_token: str = "tok-1",
    pipeline_id: str = "p-1",
) -> dict[str, Any]:
    return {
        "id": work_item_id,
        "kind": kind,
        "status": "claimed",
        "claim_token": claim_token,
        "claimed_by": "worker-stage-test",
        "claimed_at": "2026-05-28T00:00:00+00:00",
        "attempt": 1,
        "payload": {"stage": "ideation"},
        "pipeline_id": pipeline_id,
    }


class _SingleClaimSb:
    """A fake supabase client that serves one claimable row per kind.

    Wraps a real FakeSupabase so the rest of the surface (table().update()
    .eq() etc.) behaves normally; only ``rpc('claim_work_item', ...)`` is
    intercepted to serve the pre-seeded row exactly once per kind. Mirrors the
    helper in ``test_outbox_consumer``.
    """

    def __init__(self, base: Any, *, claims: dict[str, list[dict[str, Any]]]) -> None:
        self._base = base
        self._claims = {k: list(v) for k, v in claims.items()}
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
        return _Resp(queue.pop(0))

    @property
    def inserts(self) -> list[tuple[str, dict[str, Any]]]:
        return self._base.inserts

    @property
    def updates(self) -> list[tuple[str, dict[str, Any]]]:
        return self._base.updates


def _no_claims() -> dict[str, list[dict[str, Any]]]:
    return {k: [] for k in _KINDS}


# ---------------------------------------------------------------------------
# Happy path + idempotency-of-lifecycle
# ---------------------------------------------------------------------------


def test_drain_no_due_rows_reports_zero_per_kind(fake_supabase) -> None:
    """Empty queues for every kind -> tally zero per kind, no writes."""
    sb = _SingleClaimSb(fake_supabase, claims=_no_claims())
    tally = asyncio.run(run_worker_stage_drain_once(_settings(), kinds=_KINDS, sb=sb))
    assert tally == {k: 0 for k in _KINDS}
    assert fake_supabase.updates == []
    assert fake_supabase.inserts == []


def test_drain_happy_completes_ideation_row(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A claimed worker_ideation row runs its handler + is PATCHed completed."""
    seen: list[str] = []

    async def _ok(pipeline_id: str) -> dict[str, Any]:
        seen.append(pipeline_id)
        return {"pipeline_id": pipeline_id, "already_run": False}

    monkeypatch.setitem(_HANDLERS, "worker_ideation", _ok)
    row = _claim_row("worker_ideation", pipeline_id="p-7")
    sb = _SingleClaimSb(
        fake_supabase,
        claims={"worker_ideation": [row], "worker_generation": []},
    )
    tally = asyncio.run(run_worker_stage_drain_once(_settings(), kinds=_KINDS, sb=sb))

    assert tally["worker_ideation"] == 1
    assert tally["worker_generation"] == 0
    assert seen == ["p-7"]
    closes = [u for n, u in fake_supabase.updates if n == "work_item"]
    # The lifecycle writes at least the claimed->running heartbeat then the
    # terminal complete. The LAST work_item write must be the completion.
    assert closes[-1]["status"] == "completed"
    assert closes[-1]["claim_token"] is None
    assert closes[-1]["result"]["pipeline_id"] == "p-7"
    # The first work_item write is the claimed->running transition (heartbeat).
    assert any(u.get("status") == "running" for u in closes)


def test_drain_happy_completes_generation_row(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A claimed worker_generation row runs its handler + is PATCHed completed."""

    async def _ok(pipeline_id: str) -> dict[str, Any]:
        return {"pipeline_id": pipeline_id, "image_picks": 2}

    monkeypatch.setitem(_HANDLERS, "worker_generation", _ok)
    row = _claim_row("worker_generation", pipeline_id="p-gen")
    sb = _SingleClaimSb(
        fake_supabase,
        claims={"worker_ideation": [], "worker_generation": [row]},
    )
    tally = asyncio.run(run_worker_stage_drain_once(_settings(), kinds=_KINDS, sb=sb))

    assert tally["worker_generation"] == 1
    closes = [u for n, u in fake_supabase.updates if n == "work_item"]
    assert closes[-1]["status"] == "completed"
    assert closes[-1]["result"]["image_picks"] == 2


# ---------------------------------------------------------------------------
# Failure classification
# ---------------------------------------------------------------------------


def test_drain_handler_unexpected_raise_fails_row_retryable(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unexpected fault closes the row failed with a retryable error_kind."""

    async def _boom(pipeline_id: str) -> dict[str, Any]:
        raise RuntimeError("supabase blip mid-render")

    monkeypatch.setitem(_HANDLERS, "worker_generation", _boom)
    row = _claim_row("worker_generation")
    sb = _SingleClaimSb(
        fake_supabase,
        claims={"worker_ideation": [], "worker_generation": [row]},
    )
    tally = asyncio.run(run_worker_stage_drain_once(_settings(), kinds=_KINDS, sb=sb))

    assert tally["worker_generation"] == 0
    closes = [u for n, u in fake_supabase.updates if n == "work_item"]
    assert closes[-1]["status"] == "failed"
    assert closes[-1]["error_kind"] == "stage_execution_error"
    # Retryable metadata rides on error_detail so the watchdog rotates it.
    assert closes[-1]["error_detail"]["retryable"] is True
    assert closes[-1]["claim_token"] is None


def test_drain_handler_pipeline_missing_fails_terminal(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A LookupError (pipeline vanished) is a TERMINAL failure (no retry)."""

    async def _missing(pipeline_id: str) -> dict[str, Any]:
        raise LookupError(f"pipeline not found: {pipeline_id}")

    monkeypatch.setitem(_HANDLERS, "worker_ideation", _missing)
    row = _claim_row("worker_ideation")
    sb = _SingleClaimSb(
        fake_supabase,
        claims={"worker_ideation": [row], "worker_generation": []},
    )
    tally = asyncio.run(run_worker_stage_drain_once(_settings(), kinds=_KINDS, sb=sb))

    assert tally["worker_ideation"] == 0
    closes = [u for n, u in fake_supabase.updates if n == "work_item"]
    assert closes[-1]["status"] == "failed"
    assert closes[-1]["error_kind"] == "pipeline_not_found"
    assert closes[-1]["error_detail"]["retryable"] is False


def test_classify_failure_maps_kinds() -> None:
    """LookupError is terminal; everything else is retryable (pure helper)."""
    assert _classify_failure(LookupError("x")) == ("pipeline_not_found", False)
    assert _classify_failure(RuntimeError("x")) == ("stage_execution_error", True)
    assert _classify_failure(ValueError("x")) == ("stage_execution_error", True)


# ---------------------------------------------------------------------------
# Single-writer / token-rotation guards
# ---------------------------------------------------------------------------


def test_drain_initial_heartbeat_rotation_skips_dispatch(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the claim->running heartbeat hits 0 rows, do NOT dispatch or close."""
    dispatched: list[str] = []

    async def _should_not_run(pipeline_id: str) -> dict[str, Any]:
        dispatched.append(pipeline_id)
        return {}

    monkeypatch.setitem(_HANDLERS, "worker_ideation", _should_not_run)
    # The very first heartbeat (the claimed->running transition) returns False,
    # simulating a watchdog rotation between claim and first beat.
    monkeypatch.setattr(
        work_queue, "heartbeat_work_item", lambda *a, **kw: False
    )
    row = _claim_row("worker_ideation")
    sb = _SingleClaimSb(
        fake_supabase,
        claims={"worker_ideation": [row], "worker_generation": []},
    )
    tally = asyncio.run(run_worker_stage_drain_once(_settings(), kinds=_KINDS, sb=sb))

    assert tally["worker_ideation"] == 0
    assert dispatched == []
    # No terminal close was attempted (the watchdog owns the row).
    closes = [u for n, u in fake_supabase.updates if n == "work_item"]
    assert all(u.get("status") not in ("completed", "failed") for u in closes)


def test_drain_complete_token_rotated_is_logged_skip(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A terminal complete that hits 0 rows (token rotated) is a logged skip."""

    async def _ok(pipeline_id: str) -> dict[str, Any]:
        return {"pipeline_id": pipeline_id}

    monkeypatch.setitem(_HANDLERS, "worker_generation", _ok)
    # Initial claim->running heartbeat succeeds; the heartbeat loop never fires
    # (cancelled first). Only the terminal complete returns False.
    monkeypatch.setattr(work_queue, "heartbeat_work_item", lambda *a, **kw: True)
    monkeypatch.setattr(work_queue, "complete_work_item", lambda *a, **kw: False)
    row = _claim_row("worker_generation")
    sb = _SingleClaimSb(
        fake_supabase,
        claims={"worker_ideation": [], "worker_generation": [row]},
    )
    tally = asyncio.run(run_worker_stage_drain_once(_settings(), kinds=_KINDS, sb=sb))

    assert tally["worker_generation"] == 0


def test_drain_handler_fault_after_rotation_does_not_close(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A handler that raises AFTER a token rotation must not double-close.

    If the watchdog rotated the claim mid-run (heartbeat loop saw 0 rows) AND
    the handler then raises, the watchdog already owns the row -- the drain must
    not write a `fail` over it. Drive: initial claim->running beat succeeds, the
    heartbeat loop beat reports rotation, and the handler raises.
    """
    calls = {"n": 0}

    def _hb(*_a: Any, **_kw: Any) -> bool:
        calls["n"] += 1
        return calls["n"] == 1  # first (claim->running) ok; loop beat rotates

    monkeypatch.setattr(work_queue, "heartbeat_work_item", _hb)
    failed: list[str] = []
    monkeypatch.setattr(
        work_queue, "fail_work_item", lambda *a, **kw: failed.append("called") or True
    )

    async def _boom_after_rotation(pipeline_id: str) -> dict[str, Any]:
        for _ in range(50):
            await asyncio.sleep(0)
            if calls["n"] >= 2:
                break
        raise RuntimeError("crashed after the watchdog rotated us")

    monkeypatch.setitem(_HANDLERS, "worker_generation", _boom_after_rotation)
    row = _claim_row("worker_generation")
    sb = _SingleClaimSb(
        fake_supabase,
        claims={"worker_ideation": [], "worker_generation": [row]},
    )
    tally = asyncio.run(
        run_worker_stage_drain_once(
            _settings(work_item_consumer_heartbeat_s=0), kinds=_KINDS, sb=sb
        )
    )
    assert tally["worker_generation"] == 0
    # No fail write -- the watchdog owns the row after rotation.
    assert failed == []


def test_drain_rotation_mid_run_does_not_close(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A token rotation observed by the heartbeat task mid-run skips the close.

    We drive the rotation deterministically: the initial claim->running beat
    succeeds, but the heartbeat LOOP's beat returns False, so the loop sets the
    rotation event. The handler waits until the rotation is observed; the drain
    must then NOT complete the row (the watchdog owns it).
    """
    calls = {"n": 0}

    def _hb(*_a: Any, **_kw: Any) -> bool:
        calls["n"] += 1
        # First call = the claimed->running transition (succeeds). Every
        # subsequent call (the heartbeat loop) reports a rotation.
        return calls["n"] == 1

    monkeypatch.setattr(work_queue, "heartbeat_work_item", _hb)

    completed: list[str] = []
    monkeypatch.setattr(
        work_queue,
        "complete_work_item",
        lambda *a, **kw: completed.append("called") or True,
    )

    async def _slow(pipeline_id: str) -> dict[str, Any]:
        # Give the heartbeat loop (interval 0 below) a couple of ticks to fire
        # and observe the rotation before we return.
        for _ in range(50):
            await asyncio.sleep(0)
            if calls["n"] >= 2:
                break
        return {"pipeline_id": pipeline_id}

    monkeypatch.setitem(_HANDLERS, "worker_ideation", _slow)
    row = _claim_row("worker_ideation")
    sb = _SingleClaimSb(
        fake_supabase,
        claims={"worker_ideation": [row], "worker_generation": []},
    )
    # interval 0 so the heartbeat loop fires immediately and observes rotation.
    tally = asyncio.run(
        run_worker_stage_drain_once(
            _settings(work_item_consumer_heartbeat_s=0), kinds=_KINDS, sb=sb
        )
    )

    assert tally["worker_ideation"] == 0
    # The row was NOT completed -- the watchdog owns it after rotation.
    assert completed == []


# ---------------------------------------------------------------------------
# Robustness: bad claim / unknown kind / malformed row
# ---------------------------------------------------------------------------


def test_drain_unknown_kind_is_logged_skip(fake_supabase) -> None:
    """A kind without a registered handler is a logged skip, not a crash."""
    sb = _SingleClaimSb(fake_supabase, claims={"made_up_kind": []})
    tally = asyncio.run(
        run_worker_stage_drain_once(_settings(), kinds=["made_up_kind"], sb=sb)
    )
    assert tally == {"made_up_kind": 0}


def test_drain_claim_failure_is_logged_skip(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A claim error for one kind never aborts the rest of the pass."""

    def _boom(sb: Any, *, kind: str, consumer: str) -> Any:
        if kind == "worker_ideation":
            raise RuntimeError("claim exploded")
        return None

    monkeypatch.setattr(work_queue, "claim_work_item", _boom)
    tally = asyncio.run(
        run_worker_stage_drain_once(_settings(), kinds=_KINDS, sb=fake_supabase)
    )
    assert tally["worker_ideation"] == 0
    assert tally["worker_generation"] == 0


def test_drain_malformed_claim_row_is_held(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A claimed row missing its pipeline_id is left held (no dispatch)."""
    dispatched: list[str] = []

    async def _should_not_run(pipeline_id: str) -> dict[str, Any]:
        dispatched.append(pipeline_id)
        return {}

    monkeypatch.setitem(_HANDLERS, "worker_ideation", _should_not_run)
    row = _claim_row("worker_ideation")
    row.pop("pipeline_id")  # malformed: worker_* kinds are pipeline-scoped
    sb = _SingleClaimSb(
        fake_supabase,
        claims={"worker_ideation": [row], "worker_generation": []},
    )
    tally = asyncio.run(run_worker_stage_drain_once(_settings(), kinds=_KINDS, sb=sb))

    assert tally["worker_ideation"] == 0
    assert dispatched == []


def test_handlers_registered_for_both_kinds() -> None:
    """The wired handler table covers every worker stage the scheduler drains."""
    for kind in _KINDS:
        assert kind in _HANDLERS


# ---------------------------------------------------------------------------
# Monitor: honest no-op acknowledgement (PR-8 Step 3)
# ---------------------------------------------------------------------------


def test_drain_monitor_row_is_acknowledged_completed(fake_supabase) -> None:
    """A worker_monitor row is claimed + acknowledged (closed completed).

    The monitor ACTION (Meta pause / budget bump) is not implemented as a
    worker service; the handler is a no-op acknowledgement shell so the verdict
    is tracked + visible and the row never strands queued.
    """
    row = _claim_row("worker_monitor", pipeline_id="p-mon")
    sb = _SingleClaimSb(fake_supabase, claims={"worker_monitor": [row]})
    tally = asyncio.run(
        run_worker_stage_drain_once(_settings(), kinds=["worker_monitor"], sb=sb)
    )
    assert tally["worker_monitor"] == 1
    closes = [u for n, u in fake_supabase.updates if n == "work_item"]
    assert closes[-1]["status"] == "completed"
    assert closes[-1]["result"]["acknowledged"] is True


def test_monitor_handler_registered() -> None:
    """worker_monitor is wired into the handler table (route enqueues it)."""
    assert "worker_monitor" in _HANDLERS


# ---------------------------------------------------------------------------
# In-process handler bodies (the actual fix logic: fetch + idempotency + run)
# ---------------------------------------------------------------------------
#
# These exercise the real orchestration the handlers run (mirroring the deleted
# routes) with the producers + idempotency probes stubbed. The producers live in
# ``routes.pipeline`` and the probes in ``services.pipeline_runner``; the
# handlers import them lazily, so we patch the source modules.


def _patch_pipeline_runner(
    monkeypatch: pytest.MonkeyPatch,
    *,
    pipeline: dict[str, Any] | None,
    ideation_ran: bool = False,
    gen_state: Any = None,
    picks: tuple[list[str], list[str]] = ([], []),
) -> None:
    from src.services import pipeline_runner

    monkeypatch.setattr(pipeline_runner, "fetch_pipeline", lambda _pid: pipeline)
    monkeypatch.setattr(
        pipeline_runner, "ideation_already_ran", lambda _pid: ideation_ran
    )
    monkeypatch.setattr(pipeline_runner, "generation_state", lambda _pid: gen_state)
    monkeypatch.setattr(pipeline_runner, "picks_from_pipeline", lambda _p: picks)


def test_ideation_handler_runs_both_tracks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ideation handler awaits both producers when both tracks are active."""
    from src.routes import pipeline as pipeline_routes

    calls: list[str] = []

    async def _img(*, pipeline_id: str, brief_id: str) -> None:
        calls.append(f"image:{pipeline_id}:{brief_id}")

    async def _vid(*, pipeline_id: str, brief_id: str) -> None:
        calls.append(f"video:{pipeline_id}:{brief_id}")

    monkeypatch.setattr(pipeline_routes, "_produce_ideation_image_track", _img)
    monkeypatch.setattr(pipeline_routes, "_produce_ideation_video_track", _vid)
    _patch_pipeline_runner(
        monkeypatch,
        pipeline={
            "format_choice": "both",
            "image_brief_id": "ib-1",
            "video_brief_id": "vb-1",
        },
        ideation_ran=False,
    )

    result = asyncio.run(_handle_worker_ideation("p-1"))
    assert result["already_run"] is False
    assert result["image_track"] is True
    assert result["video_track"] is True
    assert set(calls) == {"image:p-1:ib-1", "video:p-1:vb-1"}


def test_ideation_handler_idempotent_skip(monkeypatch: pytest.MonkeyPatch) -> None:
    """When ideation already ran, the handler skips the producers."""
    from src.routes import pipeline as pipeline_routes

    async def _should_not_run(**_kw: Any) -> None:
        raise AssertionError("producer must not run on idempotent skip")

    monkeypatch.setattr(
        pipeline_routes, "_produce_ideation_image_track", _should_not_run
    )
    monkeypatch.setattr(
        pipeline_routes, "_produce_ideation_video_track", _should_not_run
    )
    _patch_pipeline_runner(
        monkeypatch,
        pipeline={"format_choice": "image", "image_brief_id": "ib-1"},
        ideation_ran=True,
    )

    result = asyncio.run(_handle_worker_ideation("p-1"))
    assert result["already_run"] is True


def test_ideation_handler_missing_pipeline_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A missing pipeline row raises LookupError (terminal fault)."""
    _patch_pipeline_runner(monkeypatch, pipeline=None)
    with pytest.raises(LookupError):
        asyncio.run(_handle_worker_ideation("p-missing"))


def test_ideation_handler_reraises_producer_fault(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unexpected producer fault is re-raised (so the work_item fails)."""
    from src.routes import pipeline as pipeline_routes

    async def _img(**_kw: Any) -> None:
        raise RuntimeError("kie unreachable")

    monkeypatch.setattr(pipeline_routes, "_produce_ideation_image_track", _img)
    _patch_pipeline_runner(
        monkeypatch,
        pipeline={"format_choice": "image", "image_brief_id": "ib-1"},
        ideation_ran=False,
    )
    with pytest.raises(RuntimeError, match="kie unreachable"):
        asyncio.run(_handle_worker_ideation("p-1"))


def test_generation_handler_runs_image_and_each_video_pick(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The generation handler awaits the image producer + one per video pick."""
    from src.routes import pipeline as pipeline_routes
    from src.services.pipeline_runner import GenerationState

    calls: list[str] = []

    async def _img(*, pipeline_id: str, creative_ids: list[str]) -> None:
        calls.append(f"image:{','.join(creative_ids)}")

    async def _vid(*, pipeline_id: str, creative_id: str) -> None:
        calls.append(f"video:{creative_id}")

    monkeypatch.setattr(pipeline_routes, "_produce_generation_image_picks", _img)
    monkeypatch.setattr(pipeline_routes, "_produce_generation_video_pick", _vid)
    _patch_pipeline_runner(
        monkeypatch,
        pipeline={"id": "p-1"},
        gen_state=GenerationState(
            already_running=False, already_complete=False, started_at=None
        ),
        picks=(["img-a"], ["vid-a", "vid-b"]),
    )

    result = asyncio.run(_handle_worker_generation("p-1"))
    assert result["image_picks"] == 1
    assert result["video_picks"] == 2
    assert calls == ["image:img-a", "video:vid-a", "video:vid-b"]


def test_generation_handler_already_running_skips(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """already_running short-circuits without invoking the producers."""
    from src.routes import pipeline as pipeline_routes
    from src.services.pipeline_runner import GenerationState

    async def _should_not_run(**_kw: Any) -> None:
        raise AssertionError("producer must not run when already_running")

    monkeypatch.setattr(
        pipeline_routes, "_produce_generation_image_picks", _should_not_run
    )
    _patch_pipeline_runner(
        monkeypatch,
        pipeline={"id": "p-1"},
        gen_state=GenerationState(
            already_running=True, already_complete=False, started_at="t0"
        ),
        picks=(["img-a"], []),
    )
    result = asyncio.run(_handle_worker_generation("p-1"))
    assert result["already_running"] is True


def test_generation_handler_already_complete_skips(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """already_complete short-circuits without invoking the producers."""
    from src.routes import pipeline as pipeline_routes
    from src.services.pipeline_runner import GenerationState

    async def _should_not_run(**_kw: Any) -> None:
        raise AssertionError("producer must not run when already_complete")

    monkeypatch.setattr(
        pipeline_routes, "_produce_generation_image_picks", _should_not_run
    )
    _patch_pipeline_runner(
        monkeypatch,
        pipeline={"id": "p-1"},
        gen_state=GenerationState(
            already_running=False, already_complete=True, started_at="t0"
        ),
        picks=(["img-a"], []),
    )
    result = asyncio.run(_handle_worker_generation("p-1"))
    assert result["already_complete"] is True


def test_generation_handler_missing_pipeline_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A missing pipeline row raises LookupError (terminal fault)."""
    _patch_pipeline_runner(monkeypatch, pipeline=None)
    with pytest.raises(LookupError):
        asyncio.run(_handle_worker_generation("p-missing"))


def test_generation_handler_reraises_producer_fault(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unexpected producer fault is re-raised (work_item fails + retries)."""
    from src.routes import pipeline as pipeline_routes
    from src.services.pipeline_runner import GenerationState

    async def _img(**_kw: Any) -> None:
        raise RuntimeError("render crashed")

    monkeypatch.setattr(pipeline_routes, "_produce_generation_image_picks", _img)
    _patch_pipeline_runner(
        monkeypatch,
        pipeline={"id": "p-1"},
        gen_state=GenerationState(
            already_running=False, already_complete=False, started_at=None
        ),
        picks=(["img-a"], []),
    )
    with pytest.raises(RuntimeError, match="render crashed"):
        asyncio.run(_handle_worker_generation("p-1"))


def test_monitor_handler_acknowledges() -> None:
    """The monitor handler is a no-op acknowledgement shell (pure)."""
    result = asyncio.run(_handle_worker_monitor("p-mon"))
    assert result == {"pipeline_id": "p-mon", "acknowledged": True}


# ---------------------------------------------------------------------------
# Heartbeat loop (the long-running keep-alive that prevents watchdog reclaim)
# ---------------------------------------------------------------------------


def test_heartbeat_loop_tolerates_transient_failure_then_rotates(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One beat raising is tolerated (next beat retries); a 0-row beat rotates.

    Drives the loop with interval 0 so it ticks immediately: beat 1 raises (a
    transient Supabase blip -> logged + continue), beat 2 returns False (the
    watchdog rotated the token) -> the loop sets the rotation event + returns.
    """
    calls = {"n": 0}

    def _hb(*_a: Any, **_kw: Any) -> bool:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("transient beat blip")
        return False  # token rotated

    monkeypatch.setattr(work_queue, "heartbeat_work_item", _hb)
    rotated = asyncio.Event()

    asyncio.run(
        worker_stage_consumer._heartbeat_until_cancelled(
            fake_supabase,
            work_item_id="wi-1",
            claim_token="tok-1",
            interval_s=0,
            on_token_rotated=rotated,
        )
    )
    assert rotated.is_set()
    assert calls["n"] == 2  # blip retried, then the rotation beat returned


def test_heartbeat_loop_cancellation_is_clean(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cancelling the heartbeat task propagates CancelledError cleanly."""
    monkeypatch.setattr(work_queue, "heartbeat_work_item", lambda *a, **kw: True)
    rotated = asyncio.Event()

    async def _run() -> None:
        task = asyncio.create_task(
            worker_stage_consumer._heartbeat_until_cancelled(
                fake_supabase,
                work_item_id="wi-1",
                claim_token="tok-1",
                interval_s=10,
                on_token_rotated=rotated,
            )
        )
        await asyncio.sleep(0)  # let it reach the sleep
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(_run())
    assert not rotated.is_set()


# ---------------------------------------------------------------------------
# FIX-A: deterministic post-generation gate handlers
# (worker_qa / worker_compliance / worker_spec)
# ---------------------------------------------------------------------------
#
# These exercise the real handler orchestration: resolve in-scope creatives the
# way the trigger seeded them, skip the already-passed ones (resume-by-skip-
# done), and call the verdict-writer in-process. The verdict-writers
# (qa_run / compliance_run / persist_spec_result) are stubbed so the
# resolution/skip/fan-out seam is isolated from the engine internals (those have
# their own route tests).


def _patch_handler_pipeline(
    monkeypatch: pytest.MonkeyPatch, *, pipeline: dict[str, Any] | None
) -> None:
    """Patch ``fetch_pipeline`` for the deterministic handlers (imported lazily).

    The handlers ``from .pipeline_runner import fetch_pipeline`` lazily, so
    patching the source module catches the lookup.
    """
    from src.services import pipeline_runner

    monkeypatch.setattr(pipeline_runner, "fetch_pipeline", lambda _pid: pipeline)


def test_resolve_in_scope_creatives_image_track(fake_supabase) -> None:
    """Image scope: type='image' + version like v1% + not deleted + not killed."""
    fake_supabase.seed(
        "creatives",
        [
            {"id": "c-good", "brief_id": "ib-1", "type": "image", "version": "v1.0",
             "deleted_at": None, "status": "draft", "file_path_supabase": "p/good.png"},
            {"id": "c-killed", "brief_id": "ib-1", "type": "image", "version": "v1.1",
             "deleted_at": None, "status": "killed", "file_path_supabase": None},
            {"id": "c-deleted", "brief_id": "ib-1", "type": "image", "version": "v1.0",
             "deleted_at": "2026-01-01", "status": "draft", "file_path_supabase": None},
            {"id": "c-draft-version", "brief_id": "ib-1", "type": "image", "version": "v0.3",
             "deleted_at": None, "status": "draft", "file_path_supabase": None},
        ],
    )
    image, video = _resolve_in_scope_creatives(
        fake_supabase, {"format_choice": "image", "image_brief_id": "ib-1"}
    )
    assert [c["id"] for c in image] == ["c-good"]
    assert video == []


def test_resolve_in_scope_creatives_video_track(fake_supabase) -> None:
    """Video scope: status='captioned' + not deleted, joined on video_brief_id."""
    fake_supabase.seed(
        "video_creatives",
        [
            {"id": "v-cap", "brief_id": "vb-1", "status": "captioned", "deleted_at": None},
            {"id": "v-draft", "brief_id": "vb-1", "status": "rendering", "deleted_at": None},
            {"id": "v-del", "brief_id": "vb-1", "status": "captioned", "deleted_at": "2026"},
        ],
    )
    image, video = _resolve_in_scope_creatives(
        fake_supabase, {"format_choice": "video", "video_brief_id": "vb-1"}
    )
    assert image == []
    assert [c["id"] for c in video] == ["v-cap"]


def test_already_terminal_good_skips_passed(fake_supabase) -> None:
    """A passed/overridden/skipped gate row is terminal-good; pending is not."""
    fake_supabase.set_single(
        "creative_stage_state", {"status": "passed"}
    )
    assert _already_terminal_good(
        fake_supabase, creative_id="c-1", stage="creative_qa"
    ) is True

    fake_supabase.set_single("creative_stage_state", {"status": "pending"})
    assert _already_terminal_good(
        fake_supabase, creative_id="c-1", stage="creative_qa"
    ) is False

    fake_supabase.set_single("creative_stage_state", None)
    assert _already_terminal_good(
        fake_supabase, creative_id="c-1", stage="creative_qa"
    ) is False


def test_qa_handler_fans_qa_run_over_unpassed(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """worker_qa builds QA items for unpassed in-scope creatives + calls qa_run."""
    from src.routes import qa_compliance

    fake_supabase.seed(
        "creatives",
        [
            {"id": "c-1", "brief_id": "ib-1", "type": "image", "version": "v1.0",
             "deleted_at": None, "status": "draft", "file_path_supabase": "p/1.png"},
            {"id": "c-2", "brief_id": "ib-1", "type": "image", "version": "v1.0",
             "deleted_at": None, "status": "draft", "file_path_supabase": "p/2.png"},
        ],
    )
    # c-1 already passed (skip-done); c-2 still pending.
    def _state() -> dict[str, Any] | None:
        return None  # default: no row -> not terminal-good

    # Override per-creative: c-1 passed, c-2 absent. The fake's single_override
    # is global per table, so drive skip-done via a captured set instead.
    passed = {"c-1"}
    monkeypatch.setattr(
        worker_stage_consumer,
        "_already_terminal_good",
        lambda sb, *, creative_id, stage: creative_id in passed,
    )

    captured: dict[str, Any] = {}

    async def _qa_run(body: Any) -> dict[str, Any]:
        captured["item_ids"] = [i.creative_id for i in body.items]
        return {"results": [{"creative_id": "c-2"}], "errors": [], "rollup": "passed"}

    monkeypatch.setattr(qa_compliance, "qa_run", _qa_run)
    _patch_handler_pipeline(
        monkeypatch, pipeline={"format_choice": "image", "image_brief_id": "ib-1"}
    )

    result = asyncio.run(_handle_worker_qa("p-1"))
    assert captured["item_ids"] == ["c-2"]
    assert result["adjudicated"] == 1
    assert result["rollup"] == "passed"


def test_qa_handler_nothing_to_do_when_all_passed(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When every in-scope creative already passed, qa_run is NOT called."""
    from src.routes import qa_compliance

    fake_supabase.seed(
        "creatives",
        [{"id": "c-1", "brief_id": "ib-1", "type": "image", "version": "v1.0",
          "deleted_at": None, "status": "draft", "file_path_supabase": "p/1.png"}],
    )
    monkeypatch.setattr(
        worker_stage_consumer,
        "_already_terminal_good",
        lambda sb, *, creative_id, stage: True,
    )

    async def _should_not_run(body: Any) -> dict[str, Any]:
        raise AssertionError("qa_run must not run when nothing is outstanding")

    monkeypatch.setattr(qa_compliance, "qa_run", _should_not_run)
    _patch_handler_pipeline(
        monkeypatch, pipeline={"format_choice": "image", "image_brief_id": "ib-1"}
    )

    result = asyncio.run(_handle_worker_qa("p-1"))
    assert result["skipped_all"] is True
    assert result["adjudicated"] == 0


def test_qa_handler_missing_pipeline_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """A missing pipeline row raises LookupError (terminal fault)."""
    _patch_handler_pipeline(monkeypatch, pipeline=None)
    with pytest.raises(LookupError):
        asyncio.run(_handle_worker_qa("p-missing"))


def test_compliance_handler_fans_compliance_run_empty_candidates(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """worker_compliance calls compliance_run with EMPTY llm_candidates."""
    from src.routes import qa_compliance

    fake_supabase.seed(
        "creatives",
        [{"id": "c-1", "brief_id": "ib-1", "type": "image", "version": "v1.0",
          "deleted_at": None, "status": "draft", "file_path_supabase": "p/1.png"}],
    )
    monkeypatch.setattr(
        worker_stage_consumer,
        "_already_terminal_good",
        lambda sb, *, creative_id, stage: False,
    )

    captured: dict[str, Any] = {}

    async def _compliance_run(body: Any) -> dict[str, Any]:
        captured["candidates"] = [i.llm_candidates for i in body.items]
        captured["ids"] = [i.creative_id for i in body.items]
        return {"results": [{"creative_id": "c-1"}], "errors": [], "rollup": "passed"}

    monkeypatch.setattr(qa_compliance, "compliance_run", _compliance_run)
    _patch_handler_pipeline(
        monkeypatch, pipeline={"format_choice": "image", "image_brief_id": "ib-1"}
    )

    result = asyncio.run(_handle_worker_compliance("p-1"))
    assert captured["ids"] == ["c-1"]
    assert captured["candidates"] == [[]]  # deterministic rules only
    assert result["adjudicated"] == 1


def test_compliance_handler_nothing_to_do(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No in-scope creatives -> compliance_run not called, skipped_all True."""
    from src.routes import qa_compliance

    async def _should_not_run(body: Any) -> dict[str, Any]:
        raise AssertionError("compliance_run must not run with no creatives")

    monkeypatch.setattr(qa_compliance, "compliance_run", _should_not_run)
    _patch_handler_pipeline(
        monkeypatch, pipeline={"format_choice": "image", "image_brief_id": "ib-1"}
    )
    result = asyncio.run(_handle_worker_compliance("p-1"))
    assert result["skipped_all"] is True


def test_compliance_handler_missing_pipeline_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A missing pipeline row raises LookupError."""
    _patch_handler_pipeline(monkeypatch, pipeline=None)
    with pytest.raises(LookupError):
        asyncio.run(_handle_worker_compliance("p-missing"))


def test_spec_handler_fans_persist_spec_result(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """worker_spec submits a feed placement per unpassed creative."""
    from src.routes import operator_stage_tools

    fake_supabase.seed(
        "creatives",
        [{"id": "c-1", "brief_id": "ib-1", "type": "image", "version": "v1.0",
          "deleted_at": None, "status": "draft", "file_path_supabase": "p/1.png"}],
    )
    monkeypatch.setattr(
        worker_stage_consumer,
        "_already_terminal_good",
        lambda sb, *, creative_id, stage: False,
    )

    captured: dict[str, Any] = {}

    async def _persist(body: Any) -> dict[str, Any]:
        captured["results"] = [
            (r.creative_id, r.platform, r.placement, r.status) for r in body.results
        ]
        return {"results": [{"creative_id": "c-1"}], "rollup": [{"creative_id": "c-1"}]}

    monkeypatch.setattr(operator_stage_tools, "persist_spec_result", _persist)
    _patch_handler_pipeline(
        monkeypatch, pipeline={"format_choice": "image", "image_brief_id": "ib-1"}
    )

    result = asyncio.run(_handle_worker_spec("p-1"))
    assert captured["results"] == [("c-1", "meta", "feed", "pass")]
    assert result["creatives"] == 1


def test_spec_handler_nothing_to_do(
    fake_supabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No unpassed creatives -> persist_spec_result not called."""
    from src.routes import operator_stage_tools

    fake_supabase.seed(
        "creatives",
        [{"id": "c-1", "brief_id": "ib-1", "type": "image", "version": "v1.0",
          "deleted_at": None, "status": "draft", "file_path_supabase": "p/1.png"}],
    )
    monkeypatch.setattr(
        worker_stage_consumer,
        "_already_terminal_good",
        lambda sb, *, creative_id, stage: True,
    )

    async def _should_not_run(body: Any) -> dict[str, Any]:
        raise AssertionError("persist_spec_result must not run when all passed")

    monkeypatch.setattr(operator_stage_tools, "persist_spec_result", _should_not_run)
    _patch_handler_pipeline(
        monkeypatch, pipeline={"format_choice": "image", "image_brief_id": "ib-1"}
    )
    result = asyncio.run(_handle_worker_spec("p-1"))
    assert result["skipped_all"] is True


def test_spec_handler_missing_pipeline_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """A missing pipeline row raises LookupError."""
    _patch_handler_pipeline(monkeypatch, pipeline=None)
    with pytest.raises(LookupError):
        asyncio.run(_handle_worker_spec("p-missing"))


def test_fix_a_handlers_registered() -> None:
    """The three FIX-A deterministic gate consumers are wired into _HANDLERS."""
    for kind in ("worker_qa", "worker_compliance", "worker_spec"):
        assert kind in _HANDLERS


def test_sb_for_handler_returns_admin_client(monkeypatch: pytest.MonkeyPatch) -> None:
    """``_sb_for_handler`` resolves the service-role admin client (lazy import)."""
    sentinel = object()
    from src import supabase_client

    monkeypatch.setattr(supabase_client, "get_supabase_admin", lambda: sentinel)
    assert worker_stage_consumer._sb_for_handler() is sentinel
