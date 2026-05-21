"""Operator-tunable policy overlay loader for voxhorizon-approvals.

The in-code :mod:`policy` engine is pure and final: it never reads a file.
This module is the **opt-in** layer that realizes the operator-tunable
``policy.yaml`` contract already documented in this plugin's README and in
``policy.yaml`` itself (the three keys ``allowlist`` /
``extra_requires_approval`` / ``blocklist``).

Why a separate module
---------------------
Ekko's hot path (:mod:`__init__`) calls :func:`policy.evaluate` directly and
is intentionally left untouched — loading this overlay is something a
*deployment* opts into, not a change to Ekko's behavior. With an empty
``policy.yaml`` (what Ekko ships) the overlay is a pure pass-through to
``evaluate``, so behavior is identical; the overlay only ever *adds* gating.

Merge semantics (must match the README table and ``policy.yaml`` comments)
--------------------------------------------------------------------------
In-code defaults always WIN over a *softening* override:

* ``blocklist``               → ``block`` (hard reject, no operator prompt).
  Highest precedence.
* in-code ``ALWAYS_ASK_PATTERNS`` and ``REQUIRES_APPROVAL`` → still
  ``ask_operator`` even if the same tool appears in the overlay's
  ``allowlist`` (you cannot allowlist away a baked-in gate).
* ``extra_requires_approval`` → ``ask_operator`` for tools the in-code policy
  doesn't already know about (this is how the operator profile gates the
  ``pipeline_operator_render`` spend tool).
* ``allowlist``               → ``allow`` for tools that are otherwise unknown
  (this is how the operator profile allowlists ``pipeline_operator_read``).
* everything else             → delegate to :func:`policy.evaluate`.

No hard PyYAML dependency: the policy files are a tiny YAML subset
(``key: []`` or ``key:`` followed by ``- item`` lines), so we parse that
subset ourselves and only use PyYAML if it happens to be installed.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .policy import (
    ALLOWLIST,
    ALWAYS_ASK_PATTERNS,
    REQUIRES_APPROVAL,
    Decision,
    evaluate,
)

#: Risk tag for a tool the operator overlay gates that the in-code policy
#: doesn't classify. ``spend`` because the operator overlay's whole reason to
#: exist is gating the paid ``render`` tool; surfaced in the operator UI.
_OVERLAY_RISK_DEFAULT = "spend"

#: The three recognised keys (kept in lock-step with ``policy.yaml`` docs).
_RECOGNISED_KEYS = ("allowlist", "extra_requires_approval", "blocklist")

#: Separator MCP hosts use to namespace a tool: ``mcp__<server>__<tool>``.
_MCP_SEP = "__"


def _matches(tool_name: str, entries: frozenset[str]) -> bool:
    """Match a (possibly MCP-namespaced) tool name against a policy entry set.

    Hermes may present an MCP tool to the ``pre_tool_call`` hook either *bare*
    (``pipeline_operator_render``) or *namespaced* with the server name
    (``mcp__pipeline-operator__pipeline_operator_render``). The policy files
    list tools by their short (bare) name, so we match if the live name either:

    * EQUALS a policy entry, or
    * ENDS WITH ``__<entry>`` — the trailing segment after MCP's ``__``
      namespacing.

    The suffix is anchored on ``__`` so ``pipeline_operator_render`` does not
    spuriously match an entry ``render`` (``..._render`` has no ``__render``
    boundary), keeping the match precise to whole namespaced segments.
    """
    if tool_name in entries:
        return True
    return any(tool_name.endswith(_MCP_SEP + entry) for entry in entries)


@dataclass(frozen=True)
class PolicyOverlay:
    """A loaded operator overlay plus an ``evaluate``-compatible decision fn.

    Build with :func:`load_overlay`. :meth:`evaluate` has the same
    ``(tool_name, args, ctx)`` signature as :func:`policy.evaluate` so it can
    be dropped in wherever the plain engine is used.
    """

    allowlist: frozenset[str]
    extra_requires_approval: frozenset[str]
    blocklist: frozenset[str]

    def evaluate(
        self, tool_name: str, args: dict, ctx: dict | None = None
    ) -> Decision:
        """Evaluate ``(tool_name, args)`` against the overlaid policy.

        Order encodes the precedence rules in the module docstring.
        """
        # 1. Hard blocklist — highest precedence, no prompt. Matching is
        #    robust to MCP namespacing (bare OR ``mcp__server__<entry>``).
        if _matches(tool_name, self.blocklist):
            return Decision(
                action="block",
                reason=f"{tool_name} is blocklisted by policy overlay",
                risk_class="unknown",
            )

        # 2. In-code baked-in gates win over a softening allowlist. If the
        #    tool is already gated in code (destructive pattern or
        #    REQUIRES_APPROVAL), defer to the engine so the overlay can't
        #    allowlist it away. These are Ekko's own (non-MCP) tools, so an
        #    exact name match against the engine's sets is correct.
        if tool_name in ALWAYS_ASK_PATTERNS or tool_name in REQUIRES_APPROVAL:
            return evaluate(tool_name, args, ctx)

        # 3. Operator-added approval requirement (e.g. the render spend tool).
        #    This wins over the overlay allowlist for the same tool, matching
        #    the "in-code defaults win over softening; gating wins over
        #    allowing" intent. Matches bare OR MCP-namespaced names.
        if _matches(tool_name, self.extra_requires_approval):
            return Decision(
                action="ask_operator",
                reason=f"{tool_name} requires operator approval (policy overlay)",
                risk_class=_OVERLAY_RISK_DEFAULT,
            )

        # 4. Operator-added allowlist (e.g. the read tool). Only reached when
        #    the tool isn't otherwise gated above. Matches bare OR namespaced.
        if _matches(tool_name, self.allowlist):
            return Decision(
                action="allow",
                reason=f"{tool_name} is allowlisted by policy overlay",
            )

        # 5. Nothing overlay-specific applies — fall back to the pure engine
        #    (its own allowlist / shell special-case / fail-closed default).
        return evaluate(tool_name, args, ctx)


def load_overlay(path: str | os.PathLike[str] | None) -> PolicyOverlay:
    """Load a ``policy.yaml``-shaped overlay file into a :class:`PolicyOverlay`.

    Args:
        path: Path to the policy file. ``None`` or a missing file yields an
            empty overlay (pure pass-through to :func:`policy.evaluate`), so
            callers can pass an optional config path without branching.

    Returns:
        A :class:`PolicyOverlay`. Unknown top-level keys are ignored
        (forward-compat); list values are coerced to a set of stripped,
        non-empty strings.
    """
    if path is None:
        return _empty_overlay()
    p = Path(path)
    if not p.is_file():
        return _empty_overlay()
    raw = _parse_policy_file(p.read_text(encoding="utf-8"))
    return PolicyOverlay(
        allowlist=_as_tool_set(raw.get("allowlist")),
        extra_requires_approval=_as_tool_set(raw.get("extra_requires_approval")),
        blocklist=_as_tool_set(raw.get("blocklist")),
    )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _empty_overlay() -> PolicyOverlay:
    return PolicyOverlay(
        allowlist=frozenset(),
        extra_requires_approval=frozenset(),
        blocklist=frozenset(),
    )


def _as_tool_set(value: object) -> frozenset[str]:
    """Coerce a parsed value to a frozenset of clean tool-name strings."""
    if not isinstance(value, list):
        return frozenset()
    return frozenset(
        item.strip()
        for item in value
        if isinstance(item, str) and item.strip()
    )


def _parse_policy_file(text: str) -> dict[str, list[str]]:
    """Parse the restricted YAML subset the policy files use.

    Uses PyYAML when available (handles the full spec); otherwise falls back
    to a tiny hand parser that understands exactly the two shapes the policy
    files use::

        key: []                # empty inline list
        key:                   # block list
          - item_a
          - item_b
        key: [a, b]            # inline list

    Anything outside that subset (in the no-PyYAML path) is ignored rather
    than guessed, so a malformed file degrades to an empty overlay rather
    than silently mis-gating.
    """
    try:  # pragma: no cover - exercised only where PyYAML is installed
        import yaml  # type: ignore

        loaded = yaml.safe_load(text)
        if isinstance(loaded, dict):
            return {
                k: v for k, v in loaded.items() if k in _RECOGNISED_KEYS
            }
        return {}
    except ImportError:
        return _parse_policy_subset(text)


def _parse_policy_subset(text: str) -> dict[str, list[str]]:
    """Dependency-free parser for the policy-file YAML subset."""
    result: dict[str, list[str]] = {}
    current_key: str | None = None
    for raw_line in text.splitlines():
        # Strip trailing comments and whitespace. We don't support '#' inside
        # values because the policy files never use it.
        line = raw_line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue

        stripped = line.strip()
        # A block-list item belongs to the most recent key.
        if stripped.startswith("- ") or stripped == "-":
            if current_key is not None:
                item = stripped[1:].strip()
                if item:
                    result[current_key].append(_unquote(item))
            continue

        # A "key:" or "key: value" line.
        if ":" in line and not line.startswith(" ") and not line.startswith("\t"):
            key, _, rest = line.partition(":")
            key = key.strip()
            rest = rest.strip()
            if key not in _RECOGNISED_KEYS:
                current_key = None
                continue
            current_key = key
            result.setdefault(key, [])
            if rest:
                result[key] = _parse_inline_list(rest)
                current_key = None  # inline lists are self-contained
    return result


def _parse_inline_list(rest: str) -> list[str]:
    """Parse ``[a, b, c]`` (or ``[]``) into a list of strings."""
    rest = rest.strip()
    if rest == "[]":
        return []
    if rest.startswith("[") and rest.endswith("]"):
        inner = rest[1:-1].strip()
        if not inner:
            return []
        return [_unquote(part.strip()) for part in inner.split(",") if part.strip()]
    # A bare scalar value on the key line — treat as a single-item list.
    return [_unquote(rest)]


def _unquote(token: str) -> str:
    """Strip matching single/double quotes from a scalar token."""
    if len(token) >= 2 and token[0] == token[-1] and token[0] in ("'", '"'):
        return token[1:-1]
    return token


__all__ = [
    "PolicyOverlay",
    "load_overlay",
]
