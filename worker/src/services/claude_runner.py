"""Wrapper around the Claude Code CLI + Anthropic SDK.

Two execution paths intentionally coexist:

1. ``run_subprocess`` shells out to the ``claude`` CLI in batch mode (``-p``).
   The CLI lives on the operator's machine and inherits its login state, so
   this path requires Claude Code to be authenticated up front (M0-4). Used
   for the image-ad-prompting skill in :func:`worker.src.routes.creative`
   where we want the agent to think with full skill context.

2. ``stream`` uses the Anthropic Python SDK directly to emit streaming
   chunks for the SSE chat-with-Ekko routes (M2-9 / V2-13). The SDK reads
   ``ANTHROPIC_API_KEY`` from the environment. Streaming over the CLI works
   but its line-delimited stdout shape is brittle to parse; the SDK gives
   us typed events for free.

Both surfaces are exposed on :class:`ClaudeRunner` so callers depend on a
single seam and tests can monkey-patch one or both methods.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import structlog


log = structlog.get_logger(__name__)


class ClaudeError(RuntimeError):
    """Raised on any failure from the CLI or SDK paths."""


@dataclass(frozen=True)
class StreamChunk:
    """One streamed delta from :meth:`ClaudeRunner.stream`.

    The shape is intentionally minimal so the SSE route layer can stamp
    it directly without translating between SDK-internal event names.

    ``type`` values:
      - ``text_delta``: ``delta`` is a chunk of assistant text.
      - ``tool_call_start``: ``tool`` is the tool name; ``input`` is its
        partial-or-final input dict.
      - ``tool_call_result``: ``tool`` is the tool name; ``result`` is the
        tool's return value.
      - ``message_stop``: stream finished cleanly.
      - ``error``: ``message`` carries the failure summary.
    """

    type: str
    delta: str | None = None
    tool: str | None = None
    input: Any | None = None
    result: Any | None = None
    message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize for SSE — drops ``None`` fields so the wire is compact."""
        out: dict[str, Any] = {"type": self.type}
        if self.delta is not None:
            out["delta"] = self.delta
        if self.tool is not None:
            out["tool"] = self.tool
        if self.input is not None:
            out["input"] = self.input
        if self.result is not None:
            out["result"] = self.result
        if self.message is not None:
            out["message"] = self.message
        return out


class ClaudeRunner:
    """Real implementation of the worker's Claude bridge.

    Stateless. Tests substitute a subclass that overrides
    :meth:`run_subprocess` and :meth:`stream` rather than monkey-patching
    the Anthropic SDK or ``asyncio.subprocess``.
    """

    # Default model for streaming. Kept as a class attribute so tests can
    # override; routes/callers should not hard-code a different model.
    DEFAULT_MODEL = "claude-opus-4-1-20250805"
    DEFAULT_MAX_TOKENS = 4096

    def __init__(
        self,
        *,
        claude_binary: str = "claude",
        anthropic_api_key: str | None = None,
        model: str | None = None,
    ) -> None:
        self.claude_binary = claude_binary
        self.anthropic_api_key = anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
        self.model = model or self.DEFAULT_MODEL

    # ------------------------------------------------------------------
    # Batch / subprocess path
    # ------------------------------------------------------------------

    async def run_subprocess(
        self,
        prompt: str,
        *,
        cwd: str | Path | None = None,
        skill_paths: list[Path] | None = None,
        timeout_s: float = 300.0,
    ) -> str:
        """Run ``claude -p <prompt>`` and return its full text response.

        This is the batch path: the agent does its thinking, calls any
        tools it has available, and prints the final assistant message to
        stdout. We capture it whole.

        Requires Claude Code to be authenticated on the worker host.
        ``skill_paths`` is a list of skill directory paths that the CLI
        should mount; we pass each via the ``--skill`` flag.

        Raises:
          ClaudeError: subprocess exits non-zero, hits the timeout, or
            the binary is missing.
        """
        cmd: list[str] = [self.claude_binary, "-p", prompt]
        if skill_paths:
            for sp in skill_paths:
                cmd += ["--skill", str(sp)]

        log.info(
            "claude_subprocess_start",
            prompt_chars=len(prompt),
            skills=[str(p) for p in (skill_paths or [])],
            cwd=str(cwd) if cwd else None,
        )

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(cwd) if cwd else None,
            )
        except FileNotFoundError as e:
            raise ClaudeError(
                f"`{self.claude_binary}` binary not on PATH — "
                "install Claude Code on the worker host (M0-4)."
            ) from e

        try:
            out_b, err_b = await asyncio.wait_for(
                proc.communicate(),
                timeout=timeout_s,
            )
        except asyncio.TimeoutError as e:
            proc.kill()
            await proc.wait()
            raise ClaudeError(
                f"claude subprocess exceeded {timeout_s:.0f}s timeout"
            ) from e

        stdout = out_b.decode("utf-8", errors="replace")
        stderr = err_b.decode("utf-8", errors="replace")

        if proc.returncode != 0:
            raise ClaudeError(
                f"claude subprocess exited {proc.returncode}: "
                f"{stderr.strip() or stdout.strip() or 'no output'}"
            )

        log.info(
            "claude_subprocess_done",
            output_chars=len(stdout),
            returncode=proc.returncode,
        )
        return stdout

    # ------------------------------------------------------------------
    # Streaming / SDK path (chat-with-Ekko)
    # ------------------------------------------------------------------

    async def stream(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        system_prompt: str | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
    ) -> AsyncIterator[StreamChunk]:
        """Stream assistant + tool events from the Anthropic SDK.

        Yields :class:`StreamChunk` objects; the route layer wraps each
        ``to_dict()`` in an SSE ``data:`` line.

        Requires ``ANTHROPIC_API_KEY`` in the environment.

        ``messages`` and ``tools`` follow the Anthropic SDK shape directly:
        https://docs.anthropic.com/claude/docs/tool-use.
        """
        if not self.anthropic_api_key:
            yield StreamChunk(
                type="error",
                message=(
                    "ANTHROPIC_API_KEY not configured — set it in the worker "
                    ".env before using chat-with-Ekko."
                ),
            )
            return

        try:
            from anthropic import AsyncAnthropic
        except ImportError as e:
            yield StreamChunk(
                type="error",
                message=f"anthropic SDK missing: {e}",
            )
            return

        client = AsyncAnthropic(api_key=self.anthropic_api_key)
        kwargs: dict[str, Any] = {
            "model": model or self.model,
            "messages": messages,
            "max_tokens": max_tokens or self.DEFAULT_MAX_TOKENS,
        }
        if system_prompt is not None:
            kwargs["system"] = system_prompt
        if tools:
            kwargs["tools"] = tools

        log.info(
            "claude_stream_start",
            model=kwargs["model"],
            message_count=len(messages),
            tool_count=len(tools or []),
        )

        try:
            async with client.messages.stream(**kwargs) as stream:
                # Anthropic SDK yields typed events; we translate to our
                # uniform StreamChunk shape so the SSE wire stays stable
                # even if the SDK adds new event types.
                async for event in stream:
                    chunk = _translate_event(event)
                    if chunk is not None:
                        yield chunk
                yield StreamChunk(type="message_stop")
        except Exception as e:
            log.warning("claude_stream_error", error=str(e))
            yield StreamChunk(type="error", message=str(e))


def _translate_event(event: Any) -> StreamChunk | None:
    """Map an Anthropic SDK stream event to a :class:`StreamChunk`.

    The SDK emits multiple event types (``ContentBlockDeltaEvent``,
    ``InputJsonDelta``, ``MessageStopEvent``, ...). We surface:
      - text deltas → ``text_delta``
      - tool input deltas → ``tool_call_start`` (input may still be partial)
      - message-stop → ``message_stop``

    Returns ``None`` for events we don't surface — they're swallowed
    silently rather than crashing the stream.
    """
    # ContentBlockDeltaEvent → text or tool input partial
    delta = getattr(event, "delta", None)
    if delta is not None:
        # Text fragment
        text = getattr(delta, "text", None)
        if isinstance(text, str) and text:
            return StreamChunk(type="text_delta", delta=text)
        # Tool input partial (the SDK calls these "input_json_delta")
        partial_json = getattr(delta, "partial_json", None)
        if isinstance(partial_json, str) and partial_json:
            # We don't know the tool name at the partial-json level — the
            # `content_block` wrapper carries it. Fall back to "unknown"
            # so the wire stays well-formed; the chat UI just shows that
            # a tool call is in flight.
            return StreamChunk(
                type="tool_call_start",
                tool=getattr(delta, "name", "tool"),
                input=partial_json,
            )

    # ContentBlockStartEvent / ContentBlockStopEvent — we can spot the
    # start of a tool_use block here to label the tool_call_start chunk.
    content_block = getattr(event, "content_block", None)
    if content_block is not None and getattr(content_block, "type", None) == "tool_use":
        return StreamChunk(
            type="tool_call_start",
            tool=getattr(content_block, "name", "tool"),
            input=getattr(content_block, "input", None) or {},
        )

    # MessageStopEvent: the outer ``async for`` finishes immediately
    # after; we still emit our own message_stop in the caller to keep the
    # SSE wire deterministic.
    return None
