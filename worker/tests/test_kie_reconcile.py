"""Tests for the kie video render reconciliation sweep (E5.2 / #514).

``services.scheduler.run_kie_reconcile_once`` is the durable safety net for the
kie video render bug: it finds renders persisted as ``submitted`` in
``video_render_tasks`` (the callback never resolved them -- a restart mid-poll or
a dropped callback), polls kie once for each via a FAKE kie client, and records
the result. We assert: a completed render is downloaded + marked ``completed``; a
failed render is marked ``failed``; a still-pending render is left + its attempt
bumped; the pass is bounded; a per-row failure never aborts the sweep; and an
empty open-set is a logged no-op.
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
    sb.seed(
        "video_render_tasks",
        [
            {
                "task_id": "veo-done",
                "is_veo": True,
                "status": "submitted",
                "theme": "roofing",
                "creative_id": "vc-1",
            }
        ],
    )
    _install_kie(
        monkeypatch,
        {"veo-done": RenderStatus("veo-done", "success", urls=["https://k/d.mp4"])},
    )

    resolved = await scheduler.run_kie_reconcile_once(_settings())
    assert resolved == 1
    assert _stub_store == ["veo-done"]
    upd = [r for n, r in sb.updates if n == "video_render_tasks"]
    assert upd and upd[-1]["status"] == "completed"
    assert upd[-1]["clip_id"] == "clip-veo-done"


async def test_reconcile_marks_failed_render(
    monkeypatch: pytest.MonkeyPatch,
    _patch_supabase: FakeSupabase,
    _stub_store: list[str],
) -> None:
    sb = _patch_supabase
    sb.seed(
        "video_render_tasks",
        [{"task_id": "veo-f", "is_veo": True, "status": "submitted"}],
    )
    _install_kie(
        monkeypatch, {"veo-f": RenderStatus("veo-f", "failed", error="quota")}
    )

    resolved = await scheduler.run_kie_reconcile_once(_settings())
    assert resolved == 1
    assert _stub_store == []  # a failure never stores
    upd = [r for n, r in sb.updates if n == "video_render_tasks"]
    assert upd and upd[-1]["status"] == "failed"
    assert upd[-1]["error"] == "quota"


async def test_reconcile_leaves_pending_and_bumps_attempt(
    monkeypatch: pytest.MonkeyPatch,
    _patch_supabase: FakeSupabase,
    _stub_store: list[str],
) -> None:
    sb = _patch_supabase
    sb.seed(
        "video_render_tasks",
        [{"task_id": "veo-p", "is_veo": True, "status": "submitted", "attempts": 1}],
    )
    _install_kie(monkeypatch, {"veo-p": RenderStatus("veo-p", "pending")})

    resolved = await scheduler.run_kie_reconcile_once(_settings())
    assert resolved == 0  # nothing terminal this pass
    assert _stub_store == []
    upd = [r for n, r in sb.updates if n == "video_render_tasks"]
    # The pending render's attempt was bumped (1 -> 2), status untouched.
    assert upd and upd[-1]["attempts"] == 2
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
    sb.seed(
        "video_render_tasks",
        [
            {"task_id": f"veo-{i}", "is_veo": True, "status": "submitted"}
            for i in range(5)
        ],
    )
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
    sb.seed(
        "video_render_tasks",
        [
            {"task_id": "veo-boom", "is_veo": True, "status": "submitted"},
            {"task_id": "veo-good", "is_veo": True, "status": "submitted"},
        ],
    )

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
    sb.seed(
        "video_render_tasks",
        [{"task_id": "veo-sf", "is_veo": True, "status": "submitted"}],
    )
    _install_kie(
        monkeypatch, {"veo-sf": RenderStatus("veo-sf", "success", urls=["https://k/s.mp4"])}
    )

    async def _boom(*, task_id: str, theme, urls):  # noqa: ANN001, ANN202, ARG001
        raise RuntimeError("store down")

    monkeypatch.setattr(video_callback, "_store_render_result", _boom)

    resolved = await scheduler.run_kie_reconcile_once(_settings())
    assert resolved == 0  # store failed -> not marked completed
    upd = [r for n, r in sb.updates if n == "video_render_tasks"]
    # The render stays open (attempt bumped), recoverable next pass.
    assert all("status" not in u or u.get("status") != "completed" for u in upd)


async def test_reconcile_skips_row_without_task_id(
    monkeypatch: pytest.MonkeyPatch,
    _patch_supabase: FakeSupabase,
    _stub_store: list[str],
) -> None:
    """A malformed open row (no task_id) is skipped, not crashed on."""
    sb = _patch_supabase
    sb.seed("video_render_tasks", [{"task_id": "", "is_veo": True, "status": "submitted"}])
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
    scheduler._bump_render_attempt(_Boom(), "t", "2026-05-24T00:00:00Z")


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


# Silent-failure PR-4: the `run_outbox_relay_once` scheduler wrapper +
# the `outbox_relay` module it delegated to were deleted. The unified
# `work_item_watchdog` covers the equivalent surface now.
