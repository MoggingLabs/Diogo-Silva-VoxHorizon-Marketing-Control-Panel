"""Tests for the Hermes kanban bridge service (HI-3 / Wave 18).

Covers parse, dispatch, supabase mirror, and tail streaming. The
HermesBridge handle is replaced with a :class:`_FakeBridge` whose
container's ``exec_run`` records the argv it was called with and
returns a scripted ``(exit_code, output)`` tuple. Supabase is
replaced with :class:`_FakeSupabase` which captures upserts /
updates so the tests can assert on the mirror side effects.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest


SHARED_SECRET = "test-secret-for-hermes-kanban-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Provision env + reset cached settings so the service constructor works."""
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "test-service-role-key")

    from src.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeContainer:
    """Captures exec_run calls and replays scripted outputs.

    The ``responses`` list is consumed in order — one entry per
    exec_run call. Each entry is either:

    * ``(exit_code:int, stdout:bytes)`` for the non-demux path,
    * ``(exit_code:int, (stdout:bytes, stderr:bytes))`` for ``demux=True``,
    * an iterable of bytes/tuples for ``stream=True``.

    Extra responses beyond what the test scripted raise loudly so a
    silent extra call doesn't go unnoticed.
    """

    def __init__(self, responses: list[Any]) -> None:
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def exec_run(self, argv: list[str], *, demux: bool = False, stream: bool = False) -> Any:
        # Record the call.
        self.calls.append({"argv": argv, "demux": demux, "stream": stream})
        if not self._responses:
            raise AssertionError(f"unexpected exec_run call: {argv}")
        return self._responses.pop(0)


class _FakeBridge:
    """Stand-in for HermesBridge — exposes ``_container()`` only."""

    def __init__(self, container: _FakeContainer) -> None:
        self._fake_container = container

    def _container(self) -> _FakeContainer:
        return self._fake_container


class _FakeTable:
    """One Supabase ``.table(...)`` chain that records its terminal call."""

    def __init__(self, sb: "_FakeSupabase", name: str) -> None:
        self.sb = sb
        self.name = name
        self._filters: list[tuple[str, Any]] = []
        self._upsert: dict[str, Any] | None = None
        self._update: dict[str, Any] | None = None
        self._on_conflict: str | None = None

    def upsert(self, data: dict[str, Any], *, on_conflict: str | None = None) -> "_FakeTable":
        self._upsert = data
        self._on_conflict = on_conflict
        return self

    def update(self, data: dict[str, Any]) -> "_FakeTable":
        self._update = data
        return self

    def eq(self, col: str, val: Any) -> "_FakeTable":
        self._filters.append((col, val))
        return self

    def execute(self) -> SimpleNamespace:
        if self.sb.fail_next:
            self.sb.fail_next = False
            raise RuntimeError("supabase boom")
        if self._upsert is not None:
            self.sb.upserts.append(
                {"table": self.name, "data": self._upsert, "on_conflict": self._on_conflict}
            )
            return SimpleNamespace(data=[self._upsert])
        if self._update is not None:
            self.sb.updates.append(
                {"table": self.name, "data": self._update, "filters": list(self._filters)}
            )
            return SimpleNamespace(data=[self._update])
        return SimpleNamespace(data=None)


class _FakeSupabase:
    """Records every write the kanban service issues."""

    def __init__(self) -> None:
        self.upserts: list[dict[str, Any]] = []
        self.updates: list[dict[str, Any]] = []
        self.fail_next = False

    def table(self, name: str) -> _FakeTable:
        return _FakeTable(self, name)


def _make_service(
    *,
    responses: list[Any] | None = None,
    supabase: _FakeSupabase | None = None,
) -> tuple[Any, _FakeContainer, _FakeSupabase]:
    """Build a service wired to a fake bridge + supabase."""
    from src.services.hermes_kanban import HermesKanbanService

    container = _FakeContainer(responses or [])
    bridge = _FakeBridge(container)
    sb = supabase or _FakeSupabase()
    service = HermesKanbanService(bridge, supabase=sb)
    return service, container, sb


# ---------------------------------------------------------------------------
# create_task
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_task_parses_id_and_mirrors() -> None:
    """Happy path — id parsed off stdout, Supabase mirror written."""
    stdout = b"Created kanban task: 7c4f1b2d-9a3e-4ff0-8001-3b6e1f2a9d11\n"
    service, container, sb = _make_service(
        responses=[(0, (stdout, b""))]
    )

    task_id = await service.create_task(
        title="Refresh audience for pipeline xyz",
        assignee="ekko",
        context={"pipeline_id": "pipe-1"},
    )

    assert task_id == "7c4f1b2d-9a3e-4ff0-8001-3b6e1f2a9d11"
    # Verify argv shape.
    assert container.calls[0]["argv"][:5] == [
        "hermes",
        "kanban",
        "create",
        "--board",
        "voxhorizon",
    ]
    assert "--title" in container.calls[0]["argv"]
    assert "Refresh audience for pipeline xyz" in container.calls[0]["argv"]
    assert container.calls[0]["demux"] is True

    # Mirror row carries the parsed id + pipeline_id from context.
    assert len(sb.upserts) == 1
    row = sb.upserts[0]
    assert row["table"] == "hermes_tasks"
    assert row["on_conflict"] == "kanban_task_id"
    assert row["data"]["kanban_task_id"] == task_id
    assert row["data"]["pipeline_id"] == "pipe-1"
    assert row["data"]["status"] == "pending"


@pytest.mark.asyncio
async def test_create_task_with_parent_appends_parent_arg() -> None:
    """parent_id flows into the CLI argv as --parent <id>."""
    service, container, _sb = _make_service(
        responses=[(0, (b"Created kanban task: child-001\n", b""))]
    )
    task_id = await service.create_task(
        title="child", parent_id="parent-001"
    )
    assert task_id == "child-001"
    argv = container.calls[0]["argv"]
    assert "--parent" in argv
    assert argv[argv.index("--parent") + 1] == "parent-001"


@pytest.mark.asyncio
async def test_create_task_short_id_format_parses() -> None:
    """Hermes can print short hex ids; the regex accepts them too."""
    service, _container, _sb = _make_service(
        responses=[(0, (b"Created kanban task: abc12345\n", b""))]
    )
    task_id = await service.create_task(title="t")
    assert task_id == "abc12345"


@pytest.mark.asyncio
async def test_create_task_non_zero_exit_raises() -> None:
    """A non-zero exit becomes HermesKanbanError carrying stdout/stderr."""
    from src.services.hermes_kanban import HermesKanbanError

    service, _container, _sb = _make_service(
        responses=[(2, (b"", b"board not found\n"))]
    )
    with pytest.raises(HermesKanbanError) as exc:
        await service.create_task(title="t")
    assert exc.value.exit_code == 2
    assert "board not found" in (exc.value.stderr or "")


@pytest.mark.asyncio
async def test_create_task_unparseable_id_raises() -> None:
    """A zero exit with garbage stdout still raises rather than returning empty."""
    from src.services.hermes_kanban import HermesKanbanError

    service, _container, _sb = _make_service(
        responses=[(0, (b"unknown banner text\n", b""))]
    )
    with pytest.raises(HermesKanbanError, match="could not parse"):
        await service.create_task(title="t")


@pytest.mark.asyncio
async def test_create_task_mirror_failure_is_swallowed() -> None:
    """A supabase outage doesn't block the create path."""
    sb = _FakeSupabase()
    sb.fail_next = True
    service, _container, _sb = _make_service(
        responses=[(0, (b"Created kanban task: t-1\n", b""))],
        supabase=sb,
    )
    task_id = await service.create_task(title="t")
    assert task_id == "t-1"
    # The failed upsert did NOT get recorded (fail_next raised before the append),
    # but the create returned successfully.
    assert sb.upserts == []


@pytest.mark.asyncio
async def test_create_task_drops_blank_pipeline_id() -> None:
    """An empty string in context['pipeline_id'] is treated as None."""
    sb = _FakeSupabase()
    service, _container, _sb = _make_service(
        responses=[(0, (b"Created kanban task: t-2\n", b""))],
        supabase=sb,
    )
    await service.create_task(title="t", context={"pipeline_id": ""})
    # pipeline_id key should be absent from the upsert (None means we don't set it)
    assert "pipeline_id" not in sb.upserts[0]["data"]


# ---------------------------------------------------------------------------
# list_tasks
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_tasks_json_array_parses() -> None:
    """JSON array output is parsed into HermesTask rows."""
    payload = [
        {
            "id": "t-1",
            "status": "running",
            "assignee": "ekko",
            "title": "task one",
            "board": "voxhorizon",
        },
        {"id": "t-2", "status": "completed", "assignee": "ekko", "title": "task two"},
    ]
    service, container, _sb = _make_service(
        responses=[(0, json.dumps(payload).encode())]
    )
    tasks = await service.list_tasks()
    assert [t.task_id for t in tasks] == ["t-1", "t-2"]
    assert tasks[0].status == "running"
    # --json was passed by default.
    assert "--json" in container.calls[0]["argv"]


@pytest.mark.asyncio
async def test_list_tasks_with_status_filter_passes_arg() -> None:
    service, container, _sb = _make_service(responses=[(0, b"[]\n")])
    tasks = await service.list_tasks(status_filter="running")
    assert tasks == []
    argv = container.calls[0]["argv"]
    assert "--status" in argv
    assert argv[argv.index("--status") + 1] == "running"


@pytest.mark.asyncio
async def test_list_tasks_ndjson_parses() -> None:
    """NDJSON output is parsed line-by-line."""
    ndjson = (
        b'{"id":"t-a","status":"pending","assignee":"ekko","title":"a"}\n'
        b'{"id":"t-b","status":"running","assignee":"ekko","title":"b"}\n'
    )
    service, _container, _sb = _make_service(responses=[(0, ndjson)])
    tasks = await service.list_tasks()
    assert {t.task_id for t in tasks} == {"t-a", "t-b"}


@pytest.mark.asyncio
async def test_list_tasks_ndjson_with_invalid_line_skips_it() -> None:
    """Garbage NDJSON lines are skipped rather than failing the parse."""
    ndjson = (
        b'{"id":"t-a","status":"pending","assignee":"ekko"}\n'
        b'not valid json\n'
        b'{"id":"t-b","status":"running","assignee":"ekko"}\n'
    )
    service, _container, _sb = _make_service(responses=[(0, ndjson)])
    tasks = await service.list_tasks()
    assert {t.task_id for t in tasks} == {"t-a", "t-b"}


@pytest.mark.asyncio
async def test_list_tasks_legacy_format_parses() -> None:
    """Whitespace-separated legacy output is parsed."""
    legacy = b"t-1 running ekko Audience refresh\nt-2 done ekko Other task\n"
    service, _container, _sb = _make_service(responses=[(0, legacy)])
    tasks = await service.list_tasks()
    assert len(tasks) == 2
    assert tasks[0].task_id == "t-1"
    assert tasks[0].title == "Audience refresh"
    assert tasks[1].title == "Other task"


@pytest.mark.asyncio
async def test_list_tasks_legacy_skips_blank_and_comment_lines() -> None:
    legacy = b"\n# header comment\nt-1 running ekko Task\n\n"
    service, _container, _sb = _make_service(responses=[(0, legacy)])
    tasks = await service.list_tasks()
    assert len(tasks) == 1
    assert tasks[0].task_id == "t-1"


@pytest.mark.asyncio
async def test_list_tasks_legacy_skips_short_rows() -> None:
    """Lines without at least three fields are skipped."""
    legacy = b"t-1 running\n"  # only two columns
    service, _container, _sb = _make_service(responses=[(0, legacy)])
    tasks = await service.list_tasks()
    assert tasks == []


@pytest.mark.asyncio
async def test_list_tasks_empty_output_returns_empty() -> None:
    service, _container, _sb = _make_service(responses=[(0, b"")])
    tasks = await service.list_tasks()
    assert tasks == []


@pytest.mark.asyncio
async def test_list_tasks_invalid_json_array_falls_back() -> None:
    """An almost-array that fails parse falls through to legacy parsing."""
    # Starts with [ so it tries JSON, fails, falls through. The legacy
    # parser can't extract anything useful so returns [].
    service, _container, _sb = _make_service(responses=[(0, b"[not valid\n")])
    tasks = await service.list_tasks()
    assert tasks == []


@pytest.mark.asyncio
async def test_list_tasks_non_zero_exit_raises() -> None:
    from src.services.hermes_kanban import HermesKanbanError

    service, _container, _sb = _make_service(responses=[(3, b"boom")])
    with pytest.raises(HermesKanbanError) as exc:
        await service.list_tasks()
    assert exc.value.exit_code == 3


# ---------------------------------------------------------------------------
# show_task
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_show_task_parses_flat_payload() -> None:
    payload = {
        "id": "t-1",
        "status": "running",
        "assignee": "ekko",
        "title": "Run audit",
        "context": {"pipeline_id": "pipe-1"},
        "result": None,
        "comments": [{"author": "ekko", "body": "hi"}],
        "events": [{"kind": "claimed"}],
    }
    service, _container, _sb = _make_service(
        responses=[(0, json.dumps(payload).encode())]
    )
    task = await service.show_task("t-1")
    assert task.task_id == "t-1"
    assert task.context == {"pipeline_id": "pipe-1"}
    assert task.comments[0]["body"] == "hi"
    assert task.events[0]["kind"] == "claimed"


@pytest.mark.asyncio
async def test_show_task_parses_wrapped_envelope() -> None:
    """Hermes also emits ``{"task": {...}, "comments": [...], "events": [...]}``."""
    payload = {
        "task": {
            "id": "t-2",
            "status": "completed",
            "assignee": "ekko",
            "title": "Done",
            "context": {},
            "result": {"ok": True},
        },
        "comments": [{"author": "ekko", "body": "shipped"}],
        "events": [{"kind": "completed"}],
    }
    service, _container, _sb = _make_service(
        responses=[(0, json.dumps(payload).encode())]
    )
    task = await service.show_task("t-2")
    assert task.task_id == "t-2"
    assert task.result == {"ok": True}
    assert task.comments[0]["body"] == "shipped"


@pytest.mark.asyncio
async def test_show_task_fills_id_when_missing() -> None:
    """If Hermes omits the id field, we stamp the requested id back on."""
    payload = {
        "status": "running",
        "assignee": "ekko",
        "title": "x",
    }
    service, _container, _sb = _make_service(
        responses=[(0, json.dumps(payload).encode())]
    )
    task = await service.show_task("requested-id")
    assert task.task_id == "requested-id"


@pytest.mark.asyncio
async def test_show_task_non_zero_exit_raises() -> None:
    from src.services.hermes_kanban import HermesKanbanError

    service, _container, _sb = _make_service(responses=[(4, b"")])
    with pytest.raises(HermesKanbanError):
        await service.show_task("t-x")


@pytest.mark.asyncio
async def test_show_task_empty_output_raises() -> None:
    from src.services.hermes_kanban import HermesKanbanError

    service, _container, _sb = _make_service(responses=[(0, b"")])
    with pytest.raises(HermesKanbanError, match="empty output"):
        await service.show_task("t-x")


@pytest.mark.asyncio
async def test_show_task_invalid_json_raises() -> None:
    from src.services.hermes_kanban import HermesKanbanError

    service, _container, _sb = _make_service(responses=[(0, b"not json")])
    with pytest.raises(HermesKanbanError, match="invalid JSON"):
        await service.show_task("t-x")


@pytest.mark.asyncio
async def test_show_task_non_object_payload_raises() -> None:
    from src.services.hermes_kanban import HermesKanbanError

    service, _container, _sb = _make_service(responses=[(0, b"[1,2,3]")])
    with pytest.raises(HermesKanbanError, match="expected object"):
        await service.show_task("t-x")


# ---------------------------------------------------------------------------
# cancel_task
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancel_task_blocks_and_mirrors_cancelled() -> None:
    sb = _FakeSupabase()
    service, container, _sb = _make_service(
        responses=[(0, b"blocked\n")], supabase=sb
    )
    await service.cancel_task("t-cancel")
    # CLI invocation.
    assert container.calls[0]["argv"] == ["hermes", "kanban", "block", "t-cancel"]
    # Mirror update.
    assert len(sb.updates) == 1
    upd = sb.updates[0]
    assert upd["data"] == {"status": "cancelled"}
    assert ("kanban_task_id", "t-cancel") in upd["filters"]


@pytest.mark.asyncio
async def test_cancel_task_non_zero_raises_and_skips_mirror() -> None:
    from src.services.hermes_kanban import HermesKanbanError

    sb = _FakeSupabase()
    service, _container, _sb = _make_service(
        responses=[(7, b"nope")], supabase=sb
    )
    with pytest.raises(HermesKanbanError):
        await service.cancel_task("t-cancel")
    assert sb.updates == []


@pytest.mark.asyncio
async def test_cancel_task_supabase_failure_is_swallowed() -> None:
    """A supabase failure on the mirror update doesn't fail the cancel."""
    sb = _FakeSupabase()
    sb.fail_next = True
    service, _container, _sb = _make_service(
        responses=[(0, b"blocked")], supabase=sb
    )
    # Should not raise.
    await service.cancel_task("t-cancel")
    assert sb.updates == []


# ---------------------------------------------------------------------------
# retry_task
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_retry_task_calls_reclaim_then_unblock() -> None:
    sb = _FakeSupabase()
    service, container, _sb = _make_service(
        responses=[(0, b"reclaimed"), (0, b"unblocked")], supabase=sb
    )
    await service.retry_task("t-retry")
    # Both reclaim and unblock were issued in order.
    assert container.calls[0]["argv"] == ["hermes", "kanban", "reclaim", "t-retry"]
    assert container.calls[1]["argv"] == ["hermes", "kanban", "unblock", "t-retry"]
    assert len(sb.updates) == 1
    assert sb.updates[0]["data"] == {"status": "ready"}


@pytest.mark.asyncio
async def test_retry_task_tolerates_single_failure() -> None:
    """Reclaim succeeding even if unblock fails (or vice versa) is fine."""
    service, _container, sb = _make_service(
        responses=[(0, b"reclaimed"), (1, b"already unblocked")],
    )
    # Should not raise — only one of the two failed.
    await service.retry_task("t-retry")
    assert len(sb.updates) == 1


@pytest.mark.asyncio
async def test_retry_task_both_failures_raises() -> None:
    from src.services.hermes_kanban import HermesKanbanError

    service, _container, sb = _make_service(
        responses=[(1, b"reclaim err"), (1, b"unblock err")],
    )
    with pytest.raises(HermesKanbanError):
        await service.retry_task("t-retry")
    # No mirror update on hard-fail.
    assert sb.updates == []


@pytest.mark.asyncio
async def test_retry_task_supabase_failure_is_swallowed() -> None:
    """A supabase failure on retry mirror is logged but not raised."""
    sb = _FakeSupabase()
    sb.fail_next = True
    service, _container, _sb = _make_service(
        responses=[(0, b"reclaimed"), (0, b"unblocked")], supabase=sb
    )
    await service.retry_task("t-retry")


# ---------------------------------------------------------------------------
# tail_events
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tail_events_parses_ndjson_lines() -> None:
    """Stream returns one event per JSON line."""
    chunks = [
        (b'{"kind":"claimed","at":"2026-01-01"}\n', b""),
        (b'{"kind":"running"}\n', b""),
        (b'{"kind":"completed"}\n', b""),
    ]
    service, container, _sb = _make_service(responses=[(None, iter(chunks))])
    events = [e async for e in service.tail_events("t-tail")]
    assert [e["kind"] for e in events] == ["claimed", "running", "completed"]
    # CLI invocation included --json + the task id.
    argv = container.calls[0]["argv"]
    assert "tail" in argv
    assert "t-tail" in argv
    assert "--json" in argv
    assert container.calls[0]["stream"] is True


@pytest.mark.asyncio
async def test_tail_events_split_chunks_buffer_correctly() -> None:
    """A JSON line split across two chunks is reassembled."""
    chunks = [
        (b'{"kind":"running","detail":"part', b""),
        (b'-1"}\n{"kind":"completed"}\n', b""),
    ]
    service, _container, _sb = _make_service(responses=[(None, iter(chunks))])
    events = [e async for e in service.tail_events("t-tail")]
    assert events[0]["detail"] == "part-1"
    assert events[1]["kind"] == "completed"


@pytest.mark.asyncio
async def test_tail_events_flushes_trailing_unterminated_line() -> None:
    """If the stream ends without a trailing \\n, the buffer is flushed."""
    chunks = [(b'{"kind":"final"}', b"")]
    service, _container, _sb = _make_service(responses=[(None, iter(chunks))])
    events = [e async for e in service.tail_events("t-tail")]
    assert events == [{"kind": "final"}]


@pytest.mark.asyncio
async def test_tail_events_skips_non_json_lines() -> None:
    """Banners or stderr-mixed text is skipped silently."""
    chunks = [
        (b"banner line\n", b""),
        (b'{"kind":"running"}\n', b""),
    ]
    service, _container, _sb = _make_service(responses=[(None, iter(chunks))])
    events = [e async for e in service.tail_events("t-tail")]
    assert events == [{"kind": "running"}]


@pytest.mark.asyncio
async def test_tail_events_skips_non_dict_payloads() -> None:
    """Lines whose JSON is an array/string/etc. are skipped."""
    chunks = [
        (b'[1,2,3]\n', b""),
        (b'"a string"\n', b""),
        (b'{"kind":"ok"}\n', b""),
    ]
    service, _container, _sb = _make_service(responses=[(None, iter(chunks))])
    events = [e async for e in service.tail_events("t-tail")]
    assert events == [{"kind": "ok"}]


@pytest.mark.asyncio
async def test_tail_events_trailing_invalid_json_is_ignored() -> None:
    """An unterminated non-JSON tail doesn't crash the iterator."""
    chunks = [(b'{"kind":"ok"}\nnot json no newline', b"")]
    service, _container, _sb = _make_service(responses=[(None, iter(chunks))])
    events = [e async for e in service.tail_events("t-tail")]
    assert events == [{"kind": "ok"}]


@pytest.mark.asyncio
async def test_tail_events_handles_none_and_empty_chunks() -> None:
    """None / empty / blank chunks don't break the stream."""
    chunks = [
        None,
        (b"", b""),
        (b'{"kind":"a"}\n', b""),
        b"",  # raw bytes empty
    ]
    service, _container, _sb = _make_service(responses=[(None, iter(chunks))])
    events = [e async for e in service.tail_events("t-tail")]
    assert events == [{"kind": "a"}]


@pytest.mark.asyncio
async def test_tail_events_with_exec_result_object() -> None:
    """Streams returned as an object exposing ``output`` are supported.

    Newer docker SDK versions wrap the stream in an ExecResult-style
    object instead of a 2-tuple. The service should handle both.
    """
    chunks = [(b'{"kind":"running"}\n', b"")]

    class _Wrapper:
        output = iter(chunks)

    service, _container, _sb = _make_service(responses=[_Wrapper()])
    events = [e async for e in service.tail_events("t-x")]
    assert events == [{"kind": "running"}]


# ---------------------------------------------------------------------------
# Internal helpers + edge cases
# ---------------------------------------------------------------------------


def test_decode_stream_chunk_handles_all_shapes() -> None:
    from src.services.hermes_kanban import HermesKanbanService

    # None
    assert HermesKanbanService._decode_stream_chunk(None) == ""
    # bytes
    assert HermesKanbanService._decode_stream_chunk(b"hello") == "hello"
    # tuple (stdout, stderr)
    assert HermesKanbanService._decode_stream_chunk((b"out", b"err")) == "outerr"
    # tuple with None halves
    assert HermesKanbanService._decode_stream_chunk((None, None)) == ""
    # something else: stringified
    assert HermesKanbanService._decode_stream_chunk(123) == "123"


def test_mirror_status_map_covers_known_statuses() -> None:
    """Every recognised status maps to a valid enum value."""
    service, _c, _sb = _make_service()
    assert service._mirror_status("running") == "running"
    assert service._mirror_status("In_Progress") == "running"
    assert service._mirror_status("queued") == "ready"
    assert service._mirror_status("done") == "completed"
    assert service._mirror_status("errored") == "failed"
    # Unknown statuses fall back to pending.
    assert service._mirror_status("invented") == "pending"


def test_hermes_task_to_dict_roundtrips() -> None:
    """HermesTask.to_dict produces a JSON-serialisable view."""
    from src.services.hermes_kanban import HermesTask

    task = HermesTask(
        task_id="t-1",
        status="running",
        assignee="ekko",
        title="hi",
        context={"a": 1},
    )
    d = task.to_dict()
    assert d["task_id"] == "t-1"
    assert d["context"] == {"a": 1}
    # Round-trips through json.
    assert json.loads(json.dumps(d))["task_id"] == "t-1"


def test_hermes_kanban_error_carries_diagnostics() -> None:
    from src.services.hermes_kanban import HermesKanbanError

    exc = HermesKanbanError(
        "boom", exit_code=3, stdout="out", stderr="err"
    )
    assert exc.exit_code == 3
    assert exc.stdout == "out"
    assert exc.stderr == "err"
    assert str(exc) == "boom"


@pytest.mark.asyncio
async def test_exec_handles_non_demux_path() -> None:
    """The non-demux exec_run branch returns stdout, empty stderr."""
    service, container, _sb = _make_service(
        responses=[(0, b"plain output")]
    )
    # list_tasks uses demux=False
    tasks = await service.list_tasks()
    assert tasks == []
    # The CLI was called WITHOUT demux=True.
    assert container.calls[0]["demux"] is False


@pytest.mark.asyncio
async def test_exec_handles_object_result() -> None:
    """exec_run returning an ExecResult-style object is handled."""
    from src.services.hermes_kanban import HermesKanbanService

    class _ExecResult:
        exit_code = 0
        output = b"Created kanban task: ekko-1\n"

    container = _FakeContainer(responses=[_ExecResult()])
    bridge = _FakeBridge(container)
    sb = _FakeSupabase()
    service = HermesKanbanService(bridge, supabase=sb)
    task_id = await service.create_task(title="t")
    assert task_id == "ekko-1"


@pytest.mark.asyncio
async def test_exec_handles_object_result_with_demux_output() -> None:
    """ExecResult with a tuple output (demux) is unpacked correctly."""
    from src.services.hermes_kanban import HermesKanbanService

    class _ExecResult:
        exit_code = 0
        output = (b"Created kanban task: ekko-2\n", b"")

    container = _FakeContainer(responses=[_ExecResult()])
    bridge = _FakeBridge(container)
    service = HermesKanbanService(bridge, supabase=_FakeSupabase())
    task_id = await service.create_task(title="t")
    assert task_id == "ekko-2"


@pytest.mark.asyncio
async def test_service_uses_default_board_when_omitted() -> None:
    """No board= keyword falls back to DEFAULT_BOARD."""
    from src.services.hermes_kanban import DEFAULT_BOARD

    service, container, _sb = _make_service(
        responses=[(0, (b"Created kanban task: t-3\n", b""))]
    )
    await service.create_task(title="t")
    argv = container.calls[0]["argv"]
    assert argv[argv.index("--board") + 1] == DEFAULT_BOARD


@pytest.mark.asyncio
async def test_exec_demux_with_unexpected_output_shape() -> None:
    """A demux=True exec with output that's neither bytes nor a 2-tuple
    falls through to empty stdout/stderr rather than crashing."""
    from src.services.hermes_kanban import HermesKanbanError, HermesKanbanService

    class _ExecResult:
        exit_code = 0
        # Unrecognised shape — e.g. an iterator the SDK might surface.
        output = ["weird", "shape"]

    container = _FakeContainer(responses=[_ExecResult()])
    bridge = _FakeBridge(container)
    sb = _FakeSupabase()
    service = HermesKanbanService(bridge, supabase=sb)
    # Calling create_task with empty stdout makes the parser fail with
    # the dedicated "could not parse" error — that's the signal stdout
    # decoded to "" rather than the unpacker raising ValueError.
    with pytest.raises(HermesKanbanError, match="could not parse"):
        await service.create_task(title="t")


@pytest.mark.asyncio
async def test_list_tasks_ndjson_skips_blank_lines() -> None:
    """Blank lines between NDJSON entries are skipped."""
    ndjson = (
        b'{"id":"t-a","status":"pending","assignee":"ekko"}\n'
        b'\n'  # blank line
        b'{"id":"t-b","status":"running","assignee":"ekko"}\n'
    )
    service, _container, _sb = _make_service(responses=[(0, ndjson)])
    tasks = await service.list_tasks()
    assert {t.task_id for t in tasks} == {"t-a", "t-b"}


@pytest.mark.asyncio
async def test_tail_events_buffer_skips_blank_split_lines() -> None:
    """Newline-only chunks don't break the buffer split loop."""
    chunks = [(b'\n\n{"kind":"ok"}\n', b"")]
    service, _container, _sb = _make_service(responses=[(None, iter(chunks))])
    events = [e async for e in service.tail_events("t-x")]
    assert events == [{"kind": "ok"}]


def test_mirror_upsert_includes_result_when_provided() -> None:
    """When the mirror upsert is called with a non-None result it lands on the row."""
    service, _container, sb = _make_service()
    service._mirror_upsert(
        kanban_task_id="t-99",
        status="completed",
        assignee="ekko",
        context={},
        result={"ok": True},
    )
    assert sb.upserts[0]["data"]["result"] == {"ok": True}


@pytest.mark.asyncio
async def test_service_lazy_supabase_init(monkeypatch: pytest.MonkeyPatch) -> None:
    """If no supabase is injected, the service pulls from get_supabase_admin."""
    from src.services import hermes_kanban as hk_module

    sb = _FakeSupabase()
    monkeypatch.setattr(hk_module, "get_supabase_admin", lambda: sb)

    container = _FakeContainer(
        responses=[(0, (b"Created kanban task: lazy-1\n", b""))]
    )
    bridge = _FakeBridge(container)
    service = hk_module.HermesKanbanService(bridge)  # no supabase arg
    await service.create_task(title="lazy")
    assert sb.upserts[0]["data"]["kanban_task_id"] == "lazy-1"
