"""Pure policy engine for voxhorizon-approvals.

No I/O, no async, no time — just deterministic mapping of
``(tool_name, args)`` to a :class:`Decision`. Every other module in this
plugin builds on top of this one.

Performance contract: ``evaluate`` must run in <50 microseconds for the
allowlist hot path (see ``tests/test_policy.py::test_hot_path_latency``).
Profiling shows the dominant cost is the set membership check, so the
allowlist is a literal ``set`` rather than a frozenset to keep CPython's
``BUILD_SET`` opcode out of the hot path.

Risk classes
------------
Tags surface on the operator UI so a glance tells them why approval is
being asked. Keep the vocabulary narrow:

* ``"spend"`` — calling out to a paid API (Kie, ElevenLabs, Submagic).
* ``"external-write"`` — mutating a third-party (Slack, Drive, email).
* ``"filesystem"`` — local writes, deletes, shells.
* ``"unknown"`` — tool not in either set; treat as risky and ask.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Decision:
    """Outcome of :func:`evaluate`.

    Frozen + slotted-by-default (frozen dataclasses inherit ``__slots__``
    indirectly via the immutable backing) so the hot path doesn't allocate
    a mutable dict per call.
    """

    action: str  # "allow" | "ask_operator" | "block"
    reason: str
    risk_class: str | None = None


# ---------------------------------------------------------------------------
# Static rule tables
# ---------------------------------------------------------------------------

#: Tools that NEVER hit the worker — pure reads or low-risk navigation.
#: Keep this set small; every entry is an attack surface if compromised.
ALLOWLIST: frozenset[str] = frozenset(
    {
        "read_file",
        "list_files",
        "glob",
        "grep",
        "search_files",
        "session_search",
        "memory_search",
        "skill_view",
        "view_image",
        "browser_screenshot",
        # Hermes' web tools are read-only HTTP; URL-policy enforcement is
        # left to the worker / future allowlist layer rather than baked in
        # here so a future "blocked-domains" config doesn't have to ship
        # alongside a new plugin release.
        "web_search",
        "fetch_url",
    }
)

#: Tools that ALWAYS round-trip to the operator (modulo cache).
REQUIRES_APPROVAL: frozenset[str] = frozenset(
    {
        # Paid APIs — operator approval gates the spend.
        "kie_generate",
        "elevenlabs_tts",
        "submagic_caption",
        # External-state writes — operator gates the side-effect.
        "send_email",
        "post_slack",
        "post_telegram",
        "drive_upload",
        "supabase_write",
        # Local mutations — operator gates the filesystem / shell.
        "shell_command",
        "write_file",
        "edit_file",
        "delete_file",
    }
)

#: Spend-class tools — surfaced in ``Decision.risk_class``.
_SPEND_TOOLS: frozenset[str] = frozenset(
    {"kie_generate", "elevenlabs_tts", "submagic_caption"}
)

#: Filesystem / shell tools — surfaced in ``Decision.risk_class``.
_FILESYSTEM_TOOLS: frozenset[str] = frozenset(
    {"shell_command", "write_file", "edit_file", "delete_file"}
)

#: Destructive commands that bypass cache entirely — even if a prior
#: session approved ``shell_command``, ``rm -rf /opt/data`` re-asks. The
#: patterns are intentionally narrow to avoid false positives.
ALWAYS_ASK_PATTERNS: dict[str, re.Pattern[str]] = {
    "shell_command": re.compile(
        r"^\s*(?:sudo\s+)?(?:rm\s+-rf|dd\b|mkfs|chmod\s+777"
        r"|curl[^|]*\|\s*sh|wget[^|]*\|\s*sh)",
        re.IGNORECASE,
    ),
    # Any delete is "always ask" — operator gates every removal.
    "delete_file": re.compile(r".*"),
}

#: Read-only shell commands that are safe without round-trip. Anchored
#: at the start of the command string to avoid matching ``ls; rm -rf .``.
SAFE_SHELL_PATTERNS: re.Pattern[str] = re.compile(
    r"^\s*(?:git\s+(?:status|log|diff|show|branch|remote|config\s+--get)"
    r"|ls\b|cat\b|pwd\b|echo\b|date\b|whoami\b|head\b|tail\b|wc\b|env\b)",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def args_hash(tool_name: str, args: dict) -> str:
    """Stable hash for cache lookups.

    Canonical JSON encoding (sort_keys, ensure_ascii=False) means two
    semantically identical arg dicts produce the same hash even if the
    caller iterated keys in a different order.
    """
    payload = {"tool": tool_name, "args": args}
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def evaluate(
    tool_name: str, args: dict, ctx: dict | None = None
) -> Decision:
    """Map ``(tool_name, args)`` to a :class:`Decision`.

    Order matters: the ``ALWAYS_ASK_PATTERNS`` check runs before
    ``ALLOWLIST`` so that ``shell_command`` with a safe command falls
    through to the safe-shell allow, but ``shell_command`` with ``rm -rf``
    forces ask. We DON'T short-circuit on allowlist alone for
    ``shell_command`` because the safe vs. destructive distinction has to
    look at ``args``.

    Args:
        tool_name: Hermes tool identifier (e.g. ``"read_file"``).
        args: The tool's arg dict — may be ``None``-equivalent (empty
            dict) when the agent doesn't pass kwargs.
        ctx: Reserved for future per-call context (session, skill, …);
            currently unused but accepted so callers don't need a new
            signature when we expand the policy.

    Returns:
        A :class:`Decision` whose ``action`` is one of ``"allow"`` or
        ``"ask_operator"``. ``"block"`` is reserved for the runtime
        post-decision response in :mod:`__init__`; the policy engine
        never blocks outright, it only asks.
    """
    # ``ctx`` is accepted for API stability but not yet consulted; pop
    # it through the signature to keep ruff and the linter happy without
    # paying the attribute-access cost in the hot path.
    del ctx  # explicit "I see you, but you're unused"

    args = args or {}

    # 1. Hard-rejects: destructive command patterns OR any delete. These
    # win over allowlist so a future enthusiastic operator can't widen
    # the allowlist to cover ``shell_command`` and accidentally smuggle
    # ``rm -rf`` past the gate.
    if tool_name in ALWAYS_ASK_PATTERNS:
        pattern = ALWAYS_ASK_PATTERNS[tool_name]
        target = (
            args.get("command")
            or args.get("path")
            or args.get("file_path")
            or ""
        )
        if pattern.search(str(target)):
            return Decision(
                action="ask_operator",
                reason=f"{tool_name} matches destructive pattern",
                risk_class="filesystem",
            )

    # 2. Shell special-case: safe read-only commands allowlist.
    if tool_name in ("shell_command", "terminal"):
        cmd = str(args.get("command", ""))
        if SAFE_SHELL_PATTERNS.match(cmd):
            return Decision(
                action="allow",
                reason="safe shell command (read-only)",
            )
        return Decision(
            action="ask_operator",
            reason="shell_command requires operator approval",
            risk_class="filesystem",
        )

    # 3. Plain allowlist.
    if tool_name in ALLOWLIST:
        return Decision(
            action="allow",
            reason=f"{tool_name} is on the allowlist",
        )

    # 4. Plain approval-required set.
    if tool_name in REQUIRES_APPROVAL:
        if tool_name in _SPEND_TOOLS:
            risk = "spend"
        elif tool_name in _FILESYSTEM_TOOLS:
            risk = "filesystem"
        else:
            risk = "external-write"
        return Decision(
            action="ask_operator",
            reason=f"{tool_name} requires operator approval",
            risk_class=risk,
        )

    # 5. Unknown tool — fail-closed. The agent gets asked, the operator
    # decides. If the tool turns out to be safe and common, the operator
    # will add it to ``policy.yaml`` for permanent allowlist.
    return Decision(
        action="ask_operator",
        reason=f"unknown tool {tool_name}, treating as risky",
        risk_class="unknown",
    )


__all__ = [
    "ALLOWLIST",
    "ALWAYS_ASK_PATTERNS",
    "Decision",
    "REQUIRES_APPROVAL",
    "SAFE_SHELL_PATTERNS",
    "args_hash",
    "evaluate",
]
