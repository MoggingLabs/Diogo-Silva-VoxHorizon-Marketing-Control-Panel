"""Tests for ClaudeRunner — subprocess + Anthropic SDK streaming."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.services import claude_runner as cr
from src.services.claude_runner import (
    ClaudeError,
    ClaudeRunner,
    StreamChunk,
    _translate_event,
)


SHARED_SECRET = "test-secret-for-claude-runner-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")

    from src.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# StreamChunk
# ---------------------------------------------------------------------------


def test_stream_chunk_to_dict_drops_none_fields() -> None:
    c = StreamChunk(type="text_delta", delta="hello")
    assert c.to_dict() == {"type": "text_delta", "delta": "hello"}


def test_stream_chunk_tool_call_carries_input() -> None:
    c = StreamChunk(type="tool_call_start", tool="regenerate_image", input={"prompt": "p"})
    assert c.to_dict() == {
        "type": "tool_call_start",
        "tool": "regenerate_image",
        "input": {"prompt": "p"},
    }


# ---------------------------------------------------------------------------
# Subprocess path
# ---------------------------------------------------------------------------


def _make_proc(returncode: int = 0, stdout: bytes = b"", stderr: bytes = b"") -> AsyncMock:
    proc = MagicMock()
    proc.returncode = returncode
    proc.communicate = AsyncMock(return_value=(stdout, stderr))
    return AsyncMock(return_value=proc)


def test_run_subprocess_returns_stdout(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_exec = _make_proc(0, b"hello assistant\n")
    monkeypatch.setattr(cr.asyncio, "create_subprocess_exec", fake_exec)

    runner = ClaudeRunner()
    out = asyncio.run(runner.run_subprocess("hello"))
    assert out.strip() == "hello assistant"


def test_run_subprocess_passes_skill_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    async def fake_exec(*args, **kwargs):
        captured["args"] = list(args)
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(b"ok", b""))
        return proc

    monkeypatch.setattr(cr.asyncio, "create_subprocess_exec", fake_exec)

    runner = ClaudeRunner()
    asyncio.run(
        runner.run_subprocess(
            "p",
            skill_paths=[Path("/tmp/skill1"), Path("/tmp/skill2")],
        )
    )
    assert captured["args"][:3] == ["claude", "-p", "p"]
    assert "/tmp/skill1" in captured["args"]
    assert "/tmp/skill2" in captured["args"]


def test_run_subprocess_raises_on_nonzero_exit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_exec = _make_proc(2, b"", b"boom")
    monkeypatch.setattr(cr.asyncio, "create_subprocess_exec", fake_exec)

    runner = ClaudeRunner()
    with pytest.raises(ClaudeError, match="exited 2"):
        asyncio.run(runner.run_subprocess("p"))


def test_run_subprocess_raises_on_missing_binary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_exec(*args, **kwargs):
        raise FileNotFoundError("claude")

    monkeypatch.setattr(cr.asyncio, "create_subprocess_exec", fake_exec)

    runner = ClaudeRunner()
    with pytest.raises(ClaudeError, match="not on PATH"):
        asyncio.run(runner.run_subprocess("p"))


def test_run_subprocess_raises_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    proc = MagicMock()
    proc.returncode = 0
    proc.kill = MagicMock()
    proc.wait = AsyncMock()

    async def slow_communicate():
        await asyncio.sleep(10)
        return (b"", b"")

    proc.communicate = slow_communicate

    async def fake_exec(*args, **kwargs):
        return proc

    monkeypatch.setattr(cr.asyncio, "create_subprocess_exec", fake_exec)

    runner = ClaudeRunner()
    with pytest.raises(ClaudeError, match="timeout"):
        asyncio.run(runner.run_subprocess("p", timeout_s=0.05))
    proc.kill.assert_called_once()


# ---------------------------------------------------------------------------
# Stream path — SDK is mocked
# ---------------------------------------------------------------------------


def test_stream_yields_error_when_api_key_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    runner = ClaudeRunner(anthropic_api_key=None)

    async def collect():
        out: list[StreamChunk] = []
        async for chunk in runner.stream([{"role": "user", "content": "hi"}]):
            out.append(chunk)
        return out

    chunks = asyncio.run(collect())
    assert len(chunks) == 1
    assert chunks[0].type == "error"
    assert "ANTHROPIC_API_KEY" in (chunks[0].message or "")


def test_stream_passes_messages_and_tools_to_sdk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    class FakeStream:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def __aiter__(self):
            async def gen():
                # No events — just verify the kwargs.
                if False:
                    yield None
            return gen()

    class FakeMessages:
        def stream(self, **kwargs):
            captured["kwargs"] = kwargs
            return FakeStream()

    class FakeClient:
        def __init__(self, *a, **kw):
            self.messages = FakeMessages()

    # Patch the SDK import inside the runner.
    import sys

    fake_module = SimpleNamespace(AsyncAnthropic=FakeClient)
    monkeypatch.setitem(sys.modules, "anthropic", fake_module)

    runner = ClaudeRunner(anthropic_api_key="ak")

    async def collect():
        out: list[StreamChunk] = []
        async for chunk in runner.stream(
            [{"role": "user", "content": "hi"}],
            tools=[{"name": "t"}],
            system_prompt="sys",
        ):
            out.append(chunk)
        return out

    chunks = asyncio.run(collect())
    # message_stop emitted at the end.
    assert chunks[-1].type == "message_stop"
    assert captured["kwargs"]["messages"] == [{"role": "user", "content": "hi"}]
    assert captured["kwargs"]["tools"] == [{"name": "t"}]
    assert captured["kwargs"]["system"] == "sys"
    assert captured["kwargs"]["model"] == ClaudeRunner.DEFAULT_MODEL


def test_stream_translates_text_delta_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeEvent:
        def __init__(self, text: str | None = None):
            self.delta = SimpleNamespace(text=text)

    class FakeStream:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def __aiter__(self):
            events = [FakeEvent("hello"), FakeEvent(" world")]

            async def gen():
                for e in events:
                    yield e

            return gen()

    class FakeMessages:
        def stream(self, **kwargs):
            return FakeStream()

    class FakeClient:
        def __init__(self, *a, **kw):
            self.messages = FakeMessages()

    import sys

    monkeypatch.setitem(sys.modules, "anthropic", SimpleNamespace(AsyncAnthropic=FakeClient))

    runner = ClaudeRunner(anthropic_api_key="ak")

    async def collect():
        out: list[StreamChunk] = []
        async for c in runner.stream([{"role": "user", "content": "go"}]):
            out.append(c)
        return out

    chunks = asyncio.run(collect())
    text_chunks = [c for c in chunks if c.type == "text_delta"]
    assert [c.delta for c in text_chunks] == ["hello", " world"]
    assert chunks[-1].type == "message_stop"


# ---------------------------------------------------------------------------
# _translate_event direct
# ---------------------------------------------------------------------------


def test_translate_event_text() -> None:
    e = SimpleNamespace(delta=SimpleNamespace(text="hi"))
    chunk = _translate_event(e)
    assert chunk is not None
    assert chunk.type == "text_delta"
    assert chunk.delta == "hi"


def test_translate_event_tool_use_block() -> None:
    e = SimpleNamespace(
        delta=None,
        content_block=SimpleNamespace(type="tool_use", name="regen", input={"x": 1}),
    )
    chunk = _translate_event(e)
    assert chunk is not None
    assert chunk.type == "tool_call_start"
    assert chunk.tool == "regen"
    assert chunk.input == {"x": 1}


def test_translate_event_unknown_returns_none() -> None:
    e = SimpleNamespace(delta=None, content_block=None)
    assert _translate_event(e) is None


def test_translate_event_partial_json_input_emits_tool_call_start() -> None:
    """An input_json_delta-style event becomes a partial-input tool_call_start."""
    e = SimpleNamespace(
        delta=SimpleNamespace(
            text=None, partial_json='{"prompt": "hi"}', name="regen"
        ),
    )
    chunk = _translate_event(e)
    assert chunk is not None
    assert chunk.type == "tool_call_start"
    assert chunk.tool == "regen"
    assert chunk.input == '{"prompt": "hi"}'


def test_translate_event_partial_json_without_name_falls_back_to_tool() -> None:
    """If the delta lacks a ``name`` attribute we still emit a labelled chunk."""
    # A delta object with neither ``text`` nor a ``name`` attribute. We give it
    # ``partial_json`` and the fallback string "tool" should kick in.
    class _D:
        text = None
        partial_json = '{"a": 1}'
        # No ``name`` attribute at all — getattr default kicks in.

    e = SimpleNamespace(delta=_D())
    chunk = _translate_event(e)
    assert chunk is not None
    assert chunk.type == "tool_call_start"
    assert chunk.tool == "tool"


def test_translate_event_empty_text_falls_through() -> None:
    """Empty-string text doesn't emit anything (falls through to content_block)."""
    e = SimpleNamespace(delta=SimpleNamespace(text="", partial_json=None), content_block=None)
    assert _translate_event(e) is None


# ---------------------------------------------------------------------------
# StreamChunk message field — drops nothing when set
# ---------------------------------------------------------------------------


def test_stream_chunk_to_dict_includes_message_when_set() -> None:
    """``message`` field on an error chunk lands in to_dict output."""
    c = StreamChunk(type="error", message="boom")
    d = c.to_dict()
    assert d == {"type": "error", "message": "boom"}


def test_stream_chunk_to_dict_result_field() -> None:
    """``result`` field on a tool_call_result chunk also propagates."""
    c = StreamChunk(type="tool_call_result", tool="regen", result={"ok": True})
    assert c.to_dict() == {
        "type": "tool_call_result",
        "tool": "regen",
        "result": {"ok": True},
    }


# ---------------------------------------------------------------------------
# stream — ImportError + general exception
# ---------------------------------------------------------------------------


def test_stream_yields_error_when_anthropic_sdk_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Missing anthropic SDK → single error chunk with the message."""
    import builtins
    import sys

    # Wipe any cached anthropic module so the ``from anthropic import``
    # statement falls through to the ImportError branch.
    monkeypatch.delitem(sys.modules, "anthropic", raising=False)

    original_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "anthropic":
            raise ImportError("no anthropic sdk on this host")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    runner = ClaudeRunner(anthropic_api_key="ak")

    async def collect():
        out = []
        async for c in runner.stream([{"role": "user", "content": "go"}]):
            out.append(c)
        return out

    chunks = asyncio.run(collect())
    assert len(chunks) == 1
    assert chunks[0].type == "error"
    assert "anthropic SDK missing" in (chunks[0].message or "")


def test_stream_yields_error_on_sdk_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Errors raised inside the SDK ``stream`` context propagate as an error chunk."""
    import sys
    from types import SimpleNamespace as SN

    class FakeStream:
        async def __aenter__(self):
            raise RuntimeError("upstream rate limit")

        async def __aexit__(self, *a):
            return False

    class FakeMessages:
        def stream(self, **kwargs):
            return FakeStream()

    class FakeClient:
        def __init__(self, *a, **kw):
            self.messages = FakeMessages()

    monkeypatch.setitem(sys.modules, "anthropic", SN(AsyncAnthropic=FakeClient))
    runner = ClaudeRunner(anthropic_api_key="ak")

    async def collect():
        out = []
        async for c in runner.stream([{"role": "user", "content": "x"}]):
            out.append(c)
        return out

    chunks = asyncio.run(collect())
    assert len(chunks) == 1
    assert chunks[0].type == "error"
    assert "rate limit" in (chunks[0].message or "")
