"""Tests for the kie video render reconciliation sweep (E5.2 / #514).

``services.scheduler.run_kie_reconcile_once`` is the durable safety net for the
kie video render bug the watchdog CANNOT cover: a kie render can FINISH remotely
while no callback ever arrives, and only an explicit poll of the kie API
discovers that. Silent-failure PR-6: the durable record is the
``work_item(kind='kie_video_render')`` (the legacy ``video_render_tasks`` table
is retired). The sweep finds the open (``claimed`` / ``running``) work_items,
polls kie once for each via a FAKE kie client, and closes the work_item. We
assert: a completed render is downloaded + the work_item closed ``completed``; a
failed render is closed ``failed``; a still-pending render is left + its attempt
bumped with backoff; the pass is bounded; a per-row failure never aborts the
sweep; and an empty open-set is a logged no-op.
"""

from __future__ import annotations

import pytest

from src.config import get_settings
from src.routes import video_callback
from src.services import kie_video, scheduler
from src.services.kie_video import RenderStatus

from .conftest import FakeSupabase


@pytest.fixture(autouse=True)
def _patch_supabase(monkeypatch: pytest.MonkeyPatch) -> FakeSupabase:
    """Point both the scheduler + video_callback at one in-memory supabase."""
    sb = FakeSupabase()
    monkeypatch.setattr("src.supabase_client.get_supabase_admin", lambda: sb)
    monkeypatch.setattr(video_callback, "get_supabase_admin", lambda: sb)
    return sb


def _settings(**over: object):  # noqa: ANN202
    """Fresh Settings from the harness env, with optional field overrides.

    ``BaseSettings`` is mutable, but the accessor is lru-cached -- build a fresh
    instance and ``model_copy`` the overrides so a test never mutates the cached
    singleton other tests share.
    """
    get_settings.cache_clear()
    s = get_settings()
    return s.model_copy(update=dict(over)) if over else s


class _FakeKie:
    """Fake KieVideoClient: returns a scripted RenderStatus per task_id."""

    def __init__(self, by_task: dict[str, RenderStatus]) -> None:
        self._by_task = by_task

    async def poll_status(self, task_id: str, is_veo: bool) -> RenderStatus:  # noqa: ARG002
        return self._by_task[task_id]


def _install_kie(monkeypatch: pytest.MonkeyPatch, by_task: dict[str, RenderStatus]) -> None:
    monkeypatch.setattr(kie_video, "KieVideoClient", lambda *a, **k: _FakeKie(by_task))


def _seed_render(
    sb: FakeSupabase,
    task_id: str,
    *,
    is_veo: bool = True,
    status: str = "running",
    attempt: int = 0,
    theme: str | None = None,
    creative_id: str | None = None,
) -> None:
    """Seed an open ``work_item(kind='kie_video_render')`` for a task_id.

    Silent-failure PR-6: the render record is a work_item; the reconcile reads
    the open (claimed/running) rows and closes them by idempotency_key. The
    task_id / is_veo / theme live in the payload.
    """
    sb.seed(
        "work_item",
        [
            {
                "id": f"wi-{task_id}",
                "kind": "kie_video_render",
                "status": status,
                "attempt": attempt,
                "idempotency_key": f"kie:render:{task_id}",
                "creative_id": creative_id,
                "payload": {
                    "task_id": task_id,
                    "is_veo": is_veo,
                    "theme": theme,
                    "creative_id": creative_id,
                },
            }
        ],
    )


def _render_updates(sb: FakeSupabase) -> list[dict[str, object]]:
    """The work_item UPDATE patches the reconcile wrote (newest last)."""
    return [r for n, r in sb.updates if n == "work_item"]


@pytest.fixture
def _stub_store(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    stored: list[str] = []

    async def _fake_store(*, task_id: str, theme, urls):  # noqa: ANN001, ANN202, ARG001
        stored.append(task_id)
        return {"clip_id": f"clip-{task_id}", "source_url": urls[0]}

    monkeypatch.setattr(video_callback, "_store_render_result", _fake_store)
    return stored


# ---------------------------------------------------------------------------


async def test_reconcile_records_completed_render(
    monkeypatch: pytest.MonkeyPatch,
    _patch_supabase: FakeSupabase,
    _stub_store: list[str],
) -> None:
    sb = _patch_supabase
    _seed_render(sb, "veo-done", theme="roofing", creative_id="vc-1")
    _install_kie(
        monkeypatch,
        {"veo-done": RenderStatus("veo-done", "success", urls=["https://k/d.mp4"])},
    )

    resolved = await scheduler.run_kie_reconcile_once(_settings())
    assert resolved == 1
    assert _stub_store == ["veo-done"]
    # Closed ONLY the work_item -- no legacy render-tasks write.
    assert not [r for n, r in sb.updates if n == "_legacy_video_render_tasks"]
    upd = _render_updates(sb)
    assert upd and upd[-1]["status"] == "completed"
    assert upd[-1]["result"]["clip_id"] == "clip-veo-done"


async def test_reconcile_marks_failed_render(
    monkeypatch: pytest.MonkeyPatch,
    _patch_supabase: FakeSupabase,
    _stub_store: list[str],
) -> None:
    sb = _patch_supabase
    _seed_render(sb, "veo-f")
    _install_kie(
        monkeypatch, {"veo-f": RenderStatus("veo-f", "failed", error="quota")}
    )

    resolved = await scheduler.run_kie_reconcile_once(_settings())
    assert resolved == 1
    assert _stub_store == []  # a failure never stores
    assert not [r for n, r in sb.updates if n == "_legacy_video_render_tasks"]
    upd = _render_updates(sb)
    assert upd and upd[-1]["status"] == "failed"
    assert upd[-1]["error_kind"] == "kie_render_failed"
    assert upd[-1]["error_detail"]["message"] == "quota"


async def test_reconcile_leaves_pending_and_bumps_attempt(
    monkeypatch: pytest.MonkeyPatch,
    _patch_supabase: FakeSupabase,
    _stub_store: list[str],
) -> None:
    sb = _patch_supabase
    _seed_render(sb, "veo-p", attempt=1)
    _install_kie(monkeypatch, {"veo-p": RenderStatus("veo-p", "pending")})

    resolved = await scheduler.run_kie_reconcile_once(_settings())
    assert resolved == 0  # nothing terminal this pass
    assert _stub_store == []
    upd = _render_updates(sb)
    # The pending render's attempt was bumped (1 -> 2) + next_attempt_at pushed
    # out; the work_item status is left running (untouched).
    assert upd and upd[-1]["attempt"] == 2
    assert "next_attempt_at" in upd[-1]
    assert all("status" not in u for u in upd)


async def test_reconcile_empty_is_noop(
    _patch_supabase: FakeSupabase,
) -> None:
    resolved = await scheduler.run_kie_reconcile_once(_settings())
    assert resolved == 0


async def test_reconcile_bounded_per_pass(
    monkeypatch: pytest.MonkeyPatch,
    _patch_supabase: FakeSupabase,
    _stub_store: list[str],
) -> None:
    sb = _patch_supabase
    for i in range(5):
        _seed_render(sb, f"veo-{i}")
    by_task = {
        f"veo-{i}": RenderStatus(f"veo-{i}", "success", urls=[f"https://k/{i}.mp4"])
        for i in range(5)
    }
    _install_kie(monkeypatch, by_task)

    # Cap at 2: only the two oldest open rows are processed this pass.
    resolved = await scheduler.run_kie_reconcile_once(
        _settings(scheduler_kie_reconcile_max_per_pass=2)
    )
    assert resolved == 2
    assert len(_stub_store) == 2


async def test_reconcile_poll_failure_skips_row(
    monkeypatch: pytest.MonkeyPatch,
    _patch_supabase: FakeSupabase,
    _stub_store: list[str],
) -> None:
    sb = _patch_supabase
    _seed_render(sb, "veo-boom")
    _seed_render(sb, "veo-good")

    class _FlakyKie:
        async def poll_status(self, task_id: str, is_veo: bool) -> RenderStatus:  # noqa: ARG002
            if task_id == "veo-boom":
                raise RuntimeError("kie down")
            return RenderStatus(task_id, "success", urls=["https://k/g.mp4"])

    monkeypatch.setattr(kie_video, "KieVideoClient", lambda *a, **k: _FlakyKie())

    # One bad poll never aborts the sweep; the good render still resolves.
    resolved = await scheduler.run_kie_reconcile_once(_settings())
    assert resolved == 1
    assert _stub_store == ["veo-good"]


async def test_reconcile_store_failure_bumps_attempt(
    monkeypatch: pytest.MonkeyPatch,
    _patch_supabase: FakeSupabase,
) -> None:
    sb = _patch_supabase
    _seed_render(sb, "veo-sf")
    _install_kie(
        monkeypatch, {"veo-sf": RenderStatus("veo-sf", "success", urls=["https://k/s.mp4"])}
    )

    async def _boom(*, task_id: str, theme, urls):  # noqa: ANN001, ANN202, ARG001
        raise RuntimeError("store down")

    monkeypatch.setattr(video_callback, "_store_render_result", _boom)

    resolved = await scheduler.run_kie_reconcile_once(_settings())
    assert resolved == 0  # store failed -> not closed completed
    upd = _render_updates(sb)
    # The render stays open (attempt bumped), recoverable next pass.
    assert all(u.get("status") != "completed" for u in upd)


async def test_reconcile_skips_row_without_task_id(
    monkeypatch: pytest.MonkeyPatch,
    _patch_supabase: FakeSupabase,
    _stub_store: list[str],
) -> None:
    """A malformed open row (no task_id in payload) is skipped, not crashed on."""
    sb = _patch_supabase
    sb.seed(
        "work_item",
        [
            {
                "kind": "kie_video_render",
                "status": "running",
                "attempt": 0,
                "idempotency_key": "kie:render:",
                "payload": {"task_id": "", "is_veo": True},
            }
        ],
    )
    _install_kie(monkeypatch, {})
    resolved = await scheduler.run_kie_reconcile_once(_settings())
    assert resolved == 0
    assert _stub_store == []


def test_bump_render_attempt_never_raises() -> None:
    """The pending-render bookkeeping write is best-effort -- it swallows errors."""

    class _Boom:
        def table(self, _name: str):  # noqa: ANN202
            raise RuntimeError("supabase down")

    # Must not raise even when the supabase double explodes.
    scheduler._bump_render_attempt(_Boom(), {"id": "wi-1", "attempt": 0})


def test_bump_render_attempt_skips_row_without_id() -> None:
    """A row with no id is a no-op (nothing to update); never raises."""

    class _NeverTable:
        def table(self, _name: str):  # noqa: ANN202
            raise AssertionError("must not touch supabase when id is missing")

    scheduler._bump_render_attempt(_NeverTable(), {"attempt": 2})


def test_start_scheduler_includes_kie_reconcile_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """start_scheduler wires the kie reconciliation loop alongside the others."""
    import asyncio

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "secret")
    get_settings.cache_clear()

    names: list[str] = []

    async def _run() -> None:
        sched = scheduler.start_scheduler(get_settings())
        names.extend(t.get_name() for t in sched._tasks)
        await sched.stop()

    asyncio.run(_run())
    get_settings.cache_clear()
    assert "scheduler:kie_reconcile" in names
    # The unified work_item_watchdog is still wired (regression guard).
    assert "scheduler:work_item_watchdog" in names


def test_start_scheduler_retires_legacy_watchdogs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Silent-failure PR-3 cutover: dispatch_watchdog + outbox_relay are gone.

    The unified work_item_watchdog covers both responsibilities now -- a
    stuck operator dispatch is a stuck work_item, and any failed outbox row
    rides the same retry chain. The two legacy loops MUST no longer be in
    the scheduler's task set.
    """
    import asyncio

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "secret")
    get_settings.cache_clear()

    names: list[str] = []

    async def _run() -> None:
        sched = scheduler.start_scheduler(get_settings())
        names.extend(t.get_name() for t in sched._tasks)
        await sched.stop()

    asyncio.run(_run())
    get_settings.cache_clear()
    # The legacy loops are retired.
    assert "scheduler:dispatch_watchdog" not in names
    assert "scheduler:outbox_relay" not in names
    # The unified work_item_watchdog covers both now.
    assert "scheduler:work_item_watchdog" in names


def test_start_scheduler_includes_worker_stage_drain_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Silent-failure PR-8: the worker-stage consumer drain loop is wired.

    The drain claims the deterministic ``worker_ideation`` / ``worker_generation``
    work_item rows the Next routes enqueue for non-operator-driven pipelines (the
    PR-3 cutover removed the fire-and-forget HTTP kicks but never built a
    claimant). Its loop MUST be in the scheduler's task set alongside the outbox
    drain + the unified watchdog.
    """
    import asyncio

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "secret")
    get_settings.cache_clear()

    names: list[str] = []

    async def _run() -> None:
        sched = scheduler.start_scheduler(get_settings())
        names.extend(t.get_name() for t in sched._tasks)
        await sched.stop()

    asyncio.run(_run())
    get_settings.cache_clear()
    assert "scheduler:worker_stage_drain" in names
    # The outbox drain + unified watchdog are still wired (regression guard).
    assert "scheduler:outbox_drain" in names
    assert "scheduler:work_item_watchdog" in names


# Silent-failure PR-4: the `run_outbox_relay_once` scheduler wrapper +
# the `outbox_relay` module it delegated to were deleted. The unified
# `work_item_watchdog` covers the equivalent surface now.
