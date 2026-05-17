"""Tests for the chat_stream module — heartbeat, runner singleton, terminal frames.

The Test Client coverage in test_creative_route.py exercises the happy path
and abort plumbing. This file fills the remaining gaps:

* ``_get_runner`` lazy ``ClaudeRunner`` construction (line 200).
* The heartbeat tick when the stream is quiet (lines 276–278).
* The ``saw_terminal`` flag updates on ``message_stop`` / ``error`` (line 284).
* Helper SSE framing + default-prompt + default-tool-set selection.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path

import pytest


SHARED_SECRET = "test-secret-for-chat-stream-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")

    from src.config import get_settings
    from src.routes import chat_stream
    from src.services.chat_abort import _reset_store

    get_settings.cache_clear()
    chat_stream._reset_runner()
    _reset_store()
    yield
    get_settings.cache_clear()
    chat_stream._reset_runner()
    _reset_store()


# ---------------------------------------------------------------------------
# _get_runner lazy construction
# ---------------------------------------------------------------------------


def test_get_runner_constructs_lazily_on_first_call() -> None:
    """The runner singleton is built on first access and re-used after."""
    from src.routes import chat_stream
    from src.services.claude_runner import ClaudeRunner

    # _reset_runner was called in the fixture so the singleton is empty.
    assert chat_stream._runner is None
    runner = chat_stream._get_runner()
    assert isinstance(runner, ClaudeRunner)
    # Second call returns the same instance.
    assert chat_stream._get_runner() is runner


def test_reset_runner_clears_singleton() -> None:
    from src.routes import chat_stream

    runner = chat_stream._get_runner()
    assert chat_stream._runner is runner
    chat_stream._reset_runner()
    assert chat_stream._runner is None


# ---------------------------------------------------------------------------
# Default tool sets
# ---------------------------------------------------------------------------


def test_default_image_tools_shape() -> None:
    from src.routes.chat_stream import _default_image_tools

    tools = _default_image_tools()
    names = {t["name"] for t in tools}
    assert "regenerate_image" in names
    assert "composite_image" in names
    for t in tools:
        assert "input_schema" in t
        assert "description" in t


def test_default_video_tools_shape() -> None:
    from src.routes.chat_stream import _default_video_tools

    tools = _default_video_tools()
    names = {t["name"] for t in tools}
    assert names == {"regenerate_voiceover", "swap_broll", "rerender_video"}


def test_build_system_prompt_branches() -> None:
    from src.routes.chat_stream import _build_system_prompt

    img = _build_system_prompt("image", "c-1")
    assert "image_id=c-1" in img
    vid = _build_system_prompt("video", "vc-2")
    assert "video_id=vc-2" in vid


# ---------------------------------------------------------------------------
# _format_sse
# ---------------------------------------------------------------------------


def test_format_sse_round_trip() -> None:
    from src.routes.chat_stream import _format_sse
    from src.services.claude_runner import StreamChunk

    line = _format_sse(StreamChunk(type="text_delta", delta="hi"))
    assert line.startswith(b"data: ")
    assert line.endswith(b"\n\n")
    payload = json.loads(line[len(b"data: ") : -2].decode())
    assert payload == {"type": "text_delta", "delta": "hi"}


# ---------------------------------------------------------------------------
# _stream_with_heartbeat — terminal flag + heartbeat tick
# ---------------------------------------------------------------------------


def test_stream_emits_heartbeat_when_producer_is_slow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Force a heartbeat by shrinking the interval below a producer's delay."""
    from src.routes import chat_stream
    from src.services.claude_runner import StreamChunk

    # Compress the heartbeat interval so the test runs fast.
    monkeypatch.setattr(chat_stream, "_HEARTBEAT_INTERVAL_S", 0.01)

    class SlowRunner:
        async def stream(self, messages, **kwargs):
            # Wait long enough that at least one heartbeat fires.
            await asyncio.sleep(0.05)
            yield StreamChunk(type="text_delta", delta="hi")

    async def collect() -> bytes:
        chunks: list[bytes] = []
        gen = chat_stream._stream_with_heartbeat(
            SlowRunner(),
            messages=[{"role": "user", "content": "x"}],
            tools=None,
            system_prompt=None,
            kind="image",
            creative_id="c-hb",
        )
        async for chunk in gen:
            chunks.append(chunk)
        return b"".join(chunks)

    body = asyncio.run(collect())
    # Heartbeat is an SSE comment line.
    assert b": keepalive\n\n" in body
    # The single text delta still made it.
    assert b"text_delta" in body
    # Terminal frame appended because the runner didn't emit one.
    assert b"message_stop" in body


def test_stream_does_not_double_emit_message_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If the runner emits its own ``message_stop``, the wrapper doesn't append a second.

    Covers ``saw_terminal = True`` (line 284).
    """
    from src.routes import chat_stream
    from src.services.claude_runner import StreamChunk

    class EmitsTerminal:
        async def stream(self, messages, **kwargs):
            yield StreamChunk(type="text_delta", delta="bye")
            yield StreamChunk(type="message_stop")

    async def collect() -> bytes:
        chunks: list[bytes] = []
        gen = chat_stream._stream_with_heartbeat(
            EmitsTerminal(),
            messages=[{"role": "user", "content": "x"}],
            tools=None,
            system_prompt=None,
            kind="image",
            creative_id="c-term",
        )
        async for chunk in gen:
            chunks.append(chunk)
        return b"".join(chunks)

    body = asyncio.run(collect())
    # Exactly one message_stop frame.
    assert body.count(b"message_stop") == 1


def test_stream_error_chunk_sets_terminal_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Error frame also counts as a terminal frame (saw_terminal=True)."""
    from src.routes import chat_stream
    from src.services.claude_runner import StreamChunk

    class EmitsError:
        async def stream(self, messages, **kwargs):
            yield StreamChunk(type="error", message="boom")

    async def collect() -> bytes:
        chunks: list[bytes] = []
        gen = chat_stream._stream_with_heartbeat(
            EmitsError(),
            messages=[{"role": "user", "content": "x"}],
            tools=None,
            system_prompt=None,
            kind="image",
            creative_id="c-err",
        )
        async for chunk in gen:
            chunks.append(chunk)
        return b"".join(chunks)

    body = asyncio.run(collect())
    # Error was passed through.
    assert b'"type": "error"' in body
    # No additional message_stop appended because saw_terminal was set.
    assert b"message_stop" not in body


def test_stream_emits_terminal_when_producer_is_silent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A producer that yields no chunks still gets a synthesized message_stop."""
    from src.routes import chat_stream

    class EmptyRunner:
        async def stream(self, messages, **kwargs):
            if False:  # pragma: no cover — generator with no yields
                yield None

    async def collect() -> bytes:
        chunks: list[bytes] = []
        gen = chat_stream._stream_with_heartbeat(
            EmptyRunner(),
            messages=[{"role": "user", "content": "x"}],
            tools=None,
            system_prompt=None,
            kind="image",
            creative_id="c-silent",
        )
        async for chunk in gen:
            chunks.append(chunk)
        return b"".join(chunks)

    body = asyncio.run(collect())
    assert b"message_stop" in body


def test_stream_clears_abort_flag_in_finally(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Even after a normal run, leftover abort flags get scrubbed."""
    from src.routes import chat_stream
    from src.services.chat_abort import get_store
    from src.services.claude_runner import StreamChunk

    # Pre-set a stale flag for this session — the stream's clear() must wipe it.
    get_store().request("image", "c-stale")
    assert get_store().is_aborted("image", "c-stale") is True

    class QuickRunner:
        async def stream(self, messages, **kwargs):
            # Stream sees the abort flag at the top of the loop and exits.
            yield StreamChunk(type="text_delta", delta="x")

    async def collect() -> bytes:
        chunks: list[bytes] = []
        gen = chat_stream._stream_with_heartbeat(
            QuickRunner(),
            messages=[{"role": "user", "content": "x"}],
            tools=None,
            system_prompt=None,
            kind="image",
            creative_id="c-stale",
        )
        async for chunk in gen:
            chunks.append(chunk)
        return b"".join(chunks)

    asyncio.run(collect())
    # The finally block in _stream_with_heartbeat must have cleared the flag.
    assert get_store().is_aborted("image", "c-stale") is False
