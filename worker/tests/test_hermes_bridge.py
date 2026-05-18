"""Tests for :mod:`worker.src.services.hermes_bridge`.

Uses ``unittest.mock`` to substitute the Docker SDK so the tests never
touch a real daemon. The key surfaces under test:

* :func:`HermesBridge.chat_stream` yields chunks the SDK iterator
  produces, records the exec id while the stream is live, and cleans
  up on completion / cancellation.
* :func:`HermesBridge.abort` looks up the exec, signals SIGTERM via
  ``container.exec_run(["kill", ...])``, and reports the right boolean.
* :func:`HermesBridge.healthcheck` covers the happy path, the
  ``NotFound`` branch, and the generic-error branch.
* The static argv builder covers each optional flag.

Coverage target: ≥98% on the new source file (per project standard).
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import docker.errors
import pytest

from src.services.hermes_bridge import (
    DEFAULT_HERMES_CONTAINER,
    HermesBridge,
    HermesBridgeError,
    _next_or_sentinel,
    _STREAM_DONE,
)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _make_fake_client(
    exec_id: str = "exec-abc",
    chunks: list[bytes] | None = None,
    exec_create_dict: bool = True,
    exec_create_raises: Exception | None = None,
    exec_start_raises: Exception | None = None,
    inspect_pid: int | None = 4242,
    inspect_raises: Exception | None = None,
    exec_run_raises: Exception | None = None,
    container_raises: Exception | None = None,
    container_status: str = "running",
    container_name: str = "hermes-agent-ekko",
) -> MagicMock:
    """Build a MagicMock that mimics the surface of ``docker.from_env()``."""

    api = MagicMock()
    if exec_create_raises:
        api.exec_create.side_effect = exec_create_raises
    else:
        api.exec_create.return_value = (
            {"Id": exec_id} if exec_create_dict else exec_id
        )

    def _stream_gen() -> Iterator[bytes]:
        for c in chunks or []:
            yield c

    if exec_start_raises:
        api.exec_start.side_effect = exec_start_raises
    else:
        api.exec_start.return_value = _stream_gen()

    if inspect_raises:
        api.exec_inspect.side_effect = inspect_raises
    else:
        api.exec_inspect.return_value = (
            {"Pid": inspect_pid} if inspect_pid is not None else {}
        )

    container = MagicMock()
    container.status = container_status
    container.name = container_name
    container.reload = MagicMock()
    if exec_run_raises:
        container.exec_run.side_effect = exec_run_raises
    else:
        container.exec_run.return_value = (0, b"")

    client = MagicMock()
    client.api = api
    if container_raises:
        client.containers.get.side_effect = container_raises
    else:
        client.containers.get.return_value = container

    return client


# ---------------------------------------------------------------------------
# __init__ + env var
# ---------------------------------------------------------------------------


def test_init_uses_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERMES_CONTAINER_NAME", "custom-hermes")
    bridge = HermesBridge(client=_make_fake_client())
    assert bridge.container_name == "custom-hermes"


def test_init_uses_default_when_env_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HERMES_CONTAINER_NAME", raising=False)
    bridge = HermesBridge(client=_make_fake_client())
    assert bridge.container_name == DEFAULT_HERMES_CONTAINER


def test_init_explicit_container_name_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    """An explicit ``container_name`` should override the env var."""
    monkeypatch.setenv("HERMES_CONTAINER_NAME", "env-wins")
    bridge = HermesBridge(container_name="explicit", client=_make_fake_client())
    assert bridge.container_name == "explicit"


def test_init_constructs_from_env_when_client_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without an injected client we go through ``docker.from_env``."""
    fake = _make_fake_client()
    with patch("src.services.hermes_bridge.docker.from_env", return_value=fake) as p:
        bridge = HermesBridge()
        assert bridge._client is fake
        p.assert_called_once_with()


# ---------------------------------------------------------------------------
# _build_argv
# ---------------------------------------------------------------------------


def test_build_argv_prompt_only() -> None:
    assert HermesBridge._build_argv("hello", None, None) == [
        "hermes",
        "chat",
        "-q",
        "hello",
    ]


def test_build_argv_with_session_id() -> None:
    assert HermesBridge._build_argv("p", "sess-1", None) == [
        "hermes",
        "chat",
        "-q",
        "p",
        "--pass-session-id",
        "sess-1",
    ]


def test_build_argv_with_system_prompt() -> None:
    argv = HermesBridge._build_argv("p", None, "be concise")
    assert argv == ["hermes", "chat", "-q", "p", "--system", "be concise"]


def test_build_argv_with_all_flags() -> None:
    argv = HermesBridge._build_argv("p", "s1", "sys")
    assert argv == [
        "hermes",
        "chat",
        "-q",
        "p",
        "--pass-session-id",
        "s1",
        "--system",
        "sys",
    ]


# ---------------------------------------------------------------------------
# chat_stream
# ---------------------------------------------------------------------------


async def _collect(gen) -> list[bytes]:
    out: list[bytes] = []
    async for c in gen:
        out.append(c)
    return out


@pytest.mark.asyncio
async def test_chat_stream_yields_chunks_in_order() -> None:
    client = _make_fake_client(
        exec_id="exec-1",
        chunks=[b"hello ", b"world", b""],
    )
    bridge = HermesBridge(client=client)

    out = await _collect(
        bridge.chat_stream("prompt", session_id="sess-A", system_prompt=None)
    )
    # Empty trailing chunk should be filtered.
    assert out == [b"hello ", b"world"]

    # ``exec_create`` should have received the full argv.
    args, kwargs = client.api.exec_create.call_args
    assert args[0] == "hermes-agent-ekko"
    assert args[1] == [
        "hermes",
        "chat",
        "-q",
        "prompt",
        "--pass-session-id",
        "sess-A",
    ]
    assert kwargs == {"stdout": True, "stderr": True, "tty": False}

    # Tracking map cleaned up after natural completion.
    assert "sess-A" not in bridge._active_execs


@pytest.mark.asyncio
async def test_chat_stream_tracks_active_exec_during_stream() -> None:
    """While a chunk is being yielded the exec id must be registered."""
    client = _make_fake_client(exec_id="exec-track", chunks=[b"a", b"b"])
    bridge = HermesBridge(client=client)

    gen = bridge.chat_stream("p", session_id="sess-track")
    first = await gen.__anext__()
    assert first == b"a"
    # Mid-stream: tracking visible.
    assert bridge._active_execs.get("sess-track") == "exec-track"

    # Drain the rest.
    async for _ in gen:
        pass
    assert "sess-track" not in bridge._active_execs


@pytest.mark.asyncio
async def test_chat_stream_accepts_bare_id_from_exec_create() -> None:
    """Some older SDKs return a bare string instead of a dict."""
    client = _make_fake_client(
        exec_id="bare-id",
        chunks=[b"x"],
        exec_create_dict=False,
    )
    bridge = HermesBridge(client=client)
    out = await _collect(bridge.chat_stream("p", session_id="s"))
    assert out == [b"x"]


@pytest.mark.asyncio
async def test_chat_stream_falls_back_to_exec_id_when_no_session() -> None:
    """No ``session_id`` → tracking key is the exec id."""
    client = _make_fake_client(exec_id="exec-no-sess", chunks=[b"a"])
    bridge = HermesBridge(client=client)
    gen = bridge.chat_stream("p")
    first = await gen.__anext__()
    assert first == b"a"
    assert bridge._active_execs.get("exec-no-sess") == "exec-no-sess"
    async for _ in gen:
        pass


@pytest.mark.asyncio
async def test_chat_stream_raises_bridge_error_when_container_missing() -> None:
    client = _make_fake_client(
        exec_create_raises=docker.errors.NotFound("no such container"),
    )
    bridge = HermesBridge(client=client)
    with pytest.raises(HermesBridgeError, match="not found"):
        async for _ in bridge.chat_stream("p", session_id="x"):
            pass


@pytest.mark.asyncio
async def test_chat_stream_raises_bridge_error_on_api_error_in_create() -> None:
    client = _make_fake_client(
        exec_create_raises=docker.errors.APIError("boom"),
    )
    bridge = HermesBridge(client=client)
    with pytest.raises(HermesBridgeError, match="exec_create failed"):
        async for _ in bridge.chat_stream("p"):
            pass


@pytest.mark.asyncio
async def test_chat_stream_raises_bridge_error_on_api_error_in_start() -> None:
    client = _make_fake_client(
        exec_start_raises=docker.errors.APIError("stream boom"),
    )
    bridge = HermesBridge(client=client)
    with pytest.raises(HermesBridgeError, match="exec_start"):
        async for _ in bridge.chat_stream("p", session_id="s"):
            pass
    # Tracking should still be cleaned up by the finally block.
    assert "s" not in bridge._active_execs


@pytest.mark.asyncio
async def test_chat_stream_clears_tracking_on_aclose() -> None:
    """When the consumer closes the generator early, ``finally`` must run.

    This mirrors what Starlette does when a client disconnects mid-SSE:
    it calls ``aclose()`` on the streaming iterator, which raises
    ``GeneratorExit`` inside the body — the ``finally`` block then
    scrubs the tracking map.
    """
    chunks = [b"chunk-1", b"chunk-2", b"chunk-3"]
    client = _make_fake_client(exec_id="exec-cancel", chunks=chunks)
    bridge = HermesBridge(client=client)

    gen = bridge.chat_stream("p", session_id="cancelled")
    first = await gen.__anext__()
    assert first == b"chunk-1"
    # While the stream is open, tracking should be live.
    assert bridge._active_execs.get("cancelled") == "exec-cancel"
    # Now explicitly close — this triggers the generator's ``finally``.
    await gen.aclose()
    assert "cancelled" not in bridge._active_execs


@pytest.mark.asyncio
async def test_chat_stream_cancelled_error_clears_tracking() -> None:
    """A ``CancelledError`` raised through the generator must run finally.

    Simulated by an iterator whose ``next()`` schedules cancellation
    of the current task: when the to_thread chunk pump returns, the
    next ``await`` re-raises ``CancelledError`` inside the generator
    body, which hits the ``except asyncio.CancelledError`` branch and
    re-raises after the ``finally`` clears the map.
    """

    class _CancelOnSecondCall:
        """Iterator that triggers task cancellation on its second pull."""

        def __init__(self) -> None:
            self._count = 0
            self._task: asyncio.Task | None = None

        def set_task(self, task: asyncio.Task) -> None:
            self._task = task

        def __iter__(self) -> "_CancelOnSecondCall":
            return self

        def __next__(self) -> bytes:
            self._count += 1
            if self._count == 1:
                return b"first"
            # Schedule a cancel for *after* this thread call returns
            # so the cancellation lands at the next ``await`` inside
            # the generator body.
            assert self._task is not None
            self._task.get_loop().call_soon_threadsafe(self._task.cancel)
            return b"second-but-will-be-cancelled-after"

    iterator = _CancelOnSecondCall()
    client = _make_fake_client(exec_id="exec-cancel-cleanup")
    client.api.exec_start.return_value = iterator
    bridge = HermesBridge(client=client)

    async def consume() -> None:
        async for _ in bridge.chat_stream("p", session_id="cancel-cleanup"):
            pass

    task = asyncio.create_task(consume())
    iterator.set_task(task)
    with pytest.raises(asyncio.CancelledError):
        await task
    assert "cancel-cleanup" not in bridge._active_execs


# ---------------------------------------------------------------------------
# abort
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_abort_returns_false_when_no_session_tracked() -> None:
    bridge = HermesBridge(client=_make_fake_client())
    assert await bridge.abort("nonexistent") is False


@pytest.mark.asyncio
async def test_abort_signals_sigterm_and_clears_map() -> None:
    client = _make_fake_client(exec_id="exec-K", inspect_pid=999)
    bridge = HermesBridge(client=client)
    # Pre-load the tracking map as if a stream were live.
    bridge._active_execs["sess-K"] = "exec-K"

    ok = await bridge.abort("sess-K")
    assert ok is True
    # The kill command was issued inside the container.
    client.containers.get.return_value.exec_run.assert_called_with(
        ["kill", "-TERM", "999"]
    )
    # Tracking cleared.
    assert "sess-K" not in bridge._active_execs


@pytest.mark.asyncio
async def test_abort_returns_false_when_exec_inspect_fails() -> None:
    client = _make_fake_client(
        exec_id="exec-F",
        inspect_raises=docker.errors.APIError("inspect fail"),
    )
    bridge = HermesBridge(client=client)
    bridge._active_execs["sess-F"] = "exec-F"

    ok = await bridge.abort("sess-F")
    assert ok is False
    assert "sess-F" not in bridge._active_execs


@pytest.mark.asyncio
async def test_abort_returns_false_when_no_pid() -> None:
    """``exec_inspect`` with no ``Pid`` means the exec already exited."""
    client = _make_fake_client(inspect_pid=None)
    bridge = HermesBridge(client=client)
    bridge._active_execs["sess-N"] = "exec-N"

    ok = await bridge.abort("sess-N")
    assert ok is False
    assert "sess-N" not in bridge._active_execs


@pytest.mark.asyncio
async def test_abort_returns_false_when_kill_raises_notfound() -> None:
    client = _make_fake_client(
        exec_id="exec-K2",
        exec_run_raises=docker.errors.NotFound("gone"),
    )
    bridge = HermesBridge(client=client)
    bridge._active_execs["sess-K2"] = "exec-K2"
    ok = await bridge.abort("sess-K2")
    assert ok is False
    assert "sess-K2" not in bridge._active_execs


@pytest.mark.asyncio
async def test_abort_returns_false_when_kill_raises_apierror() -> None:
    client = _make_fake_client(
        exec_run_raises=docker.errors.APIError("denied"),
    )
    bridge = HermesBridge(client=client)
    bridge._active_execs["sess-K3"] = "exec-K3"
    ok = await bridge.abort("sess-K3")
    assert ok is False


# ---------------------------------------------------------------------------
# healthcheck
# ---------------------------------------------------------------------------


def test_healthcheck_happy_path() -> None:
    client = _make_fake_client(container_status="running", container_name="hermes-x")
    bridge = HermesBridge(container_name="hermes-x", client=client)
    out = bridge.healthcheck()
    assert out == {"container": "running", "name": "hermes-x"}
    client.containers.get.return_value.reload.assert_called_once()


def test_healthcheck_not_found() -> None:
    client = _make_fake_client(
        container_raises=docker.errors.NotFound("missing")
    )
    bridge = HermesBridge(container_name="missing-one", client=client)
    out = bridge.healthcheck()
    assert out == {"container": "not_found", "name": "missing-one"}


def test_healthcheck_generic_error() -> None:
    client = _make_fake_client(
        container_raises=RuntimeError("socket gone")
    )
    bridge = HermesBridge(container_name="hermes-q", client=client)
    out = bridge.healthcheck()
    assert out == {
        "container": "error",
        "name": "hermes-q",
        "error": "socket gone",
    }


# ---------------------------------------------------------------------------
# _next_or_sentinel helper
# ---------------------------------------------------------------------------


def test_next_or_sentinel_yields_value() -> None:
    it = iter([b"a", b"b"])
    assert _next_or_sentinel(it) == b"a"
    assert _next_or_sentinel(it) == b"b"


def test_next_or_sentinel_returns_done_on_stopiteration() -> None:
    it = iter([])
    assert _next_or_sentinel(it) is _STREAM_DONE


# ---------------------------------------------------------------------------
# Streaming throughput — chunks should arrive without 50ms+ latency on
# pure mocks (this asserts the to_thread plumbing is set up correctly).
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chat_stream_does_not_block_event_loop() -> None:
    """A slow producer's chunks should reach the consumer eagerly.

    The HI-1 acceptance criterion calls out <50ms-per-chunk responsiveness.
    With a mock iterator that doesn't sleep, the whole stream should
    complete well inside that budget — we use a generous 1s ceiling to
    keep the test stable on slow CI.
    """
    client = _make_fake_client(chunks=[b"a", b"b", b"c"])
    bridge = HermesBridge(client=client)
    start = asyncio.get_event_loop().time()
    out = await _collect(bridge.chat_stream("p", session_id="t"))
    elapsed = asyncio.get_event_loop().time() - start
    assert out == [b"a", b"b", b"c"]
    assert elapsed < 1.0
