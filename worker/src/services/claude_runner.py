"""Wrapper around the Claude Code CLI + SDK.

Stub for M0. The real implementation in M2 will:
- spawn `claude` as a subprocess for one-shot prompts (with -p flag)
- stream JSONL events back via stdout
- load skills from `~/.claude/skills/` and surface them via /work/health
- mount our MCP servers (Supabase, Fathom, etc.) for tool calls
"""

from __future__ import annotations

from collections.abc import AsyncIterator


class ClaudeRunner:
    """Stub. Real impl lands in M2."""

    async def run_subprocess(self, prompt: str, *, cwd: str | None = None) -> str:
        raise NotImplementedError("ClaudeRunner.run_subprocess lands in M2.")

    async def run_streaming(
        self, prompt: str, *, cwd: str | None = None
    ) -> AsyncIterator[dict[str, object]]:
        raise NotImplementedError("ClaudeRunner.run_streaming lands in M2.")
        yield {}  # pragma: no cover  (typing hint that this is an async generator)
