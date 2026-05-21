"""Tests for the operator policy overlay (``policy_overlay`` + the shipped
``policy.operator.yaml``).

Mirrors the style of ``test_policy.py``: import the loader, build the overlay,
and assert decisions per tool. The contract under test:

* ``pipeline_operator_render`` (the SPEND tool) is GATED (``ask_operator``).
* ``pipeline_operator_read`` / ``pipeline_operator_brief`` are ALLOWLISTED.
* In-code defaults still WIN over the overlay (you can't allowlist away a
  baked-in gate; ``rm -rf`` still asks; ``kie_generate`` still asks).
* The shipped ``policy.operator.yaml`` parses to exactly those sets.
* An EMPTY overlay is a pure pass-through to ``policy.evaluate`` — proof that
  loading the overlay doesn't change Ekko's behavior when its (empty) policy
  is in place.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from voxhorizon_approvals.policy import evaluate
from voxhorizon_approvals.policy_overlay import PolicyOverlay, load_overlay

#: The shipped operator profile lives next to the package.
OPERATOR_POLICY_PATH = (
    Path(__file__).resolve().parent.parent / "policy.operator.yaml"
)


@pytest.fixture
def operator_overlay() -> PolicyOverlay:
    return load_overlay(OPERATOR_POLICY_PATH)


# ---------------------------------------------------------------------------
# The operator profile gates render + allowlists read/brief
# ---------------------------------------------------------------------------


def test_render_tool_is_gated(operator_overlay: PolicyOverlay) -> None:
    """The spend tool requires operator approval under the operator policy."""
    decision = operator_overlay.evaluate("pipeline_operator_render", {})
    assert decision.action == "ask_operator"
    assert decision.risk_class == "spend"
    assert "pipeline_operator_render" in decision.reason


def test_render_tool_gated_regardless_of_args(
    operator_overlay: PolicyOverlay,
) -> None:
    decision = operator_overlay.evaluate(
        "pipeline_operator_render",
        {"pipeline_id": "p-1", "kind": "concept_preview", "items": [{}]},
    )
    assert decision.action == "ask_operator"


def test_read_tool_is_allowlisted(operator_overlay: PolicyOverlay) -> None:
    """The read tool is allowed without an operator round-trip."""
    decision = operator_overlay.evaluate("pipeline_operator_read", {})
    assert decision.action == "allow"
    assert "allowlist" in decision.reason


def test_brief_tool_is_allowlisted(operator_overlay: PolicyOverlay) -> None:
    """The brief tool (free write, reviewed via the stage gate) is allowed."""
    decision = operator_overlay.evaluate("pipeline_operator_brief", {})
    assert decision.action == "allow"


# ---------------------------------------------------------------------------
# MCP tool-name namespacing — match bare AND mcp__server__<entry>
# ---------------------------------------------------------------------------
#
# Hermes may present an MCP tool to the hook either bare
# (``pipeline_operator_render``) or namespaced with the server name
# (``mcp__pipeline-operator__pipeline_operator_render``). The overlay must gate
# either form so the spend gate fires regardless of which the live runtime uses.

#: The MCP server name (matches mcp_server.py's ``SERVER_NAME``).
_NS = "mcp__pipeline-operator__"


@pytest.mark.parametrize(
    "name",
    [
        "pipeline_operator_render",  # bare
        _NS + "pipeline_operator_render",  # namespaced
    ],
)
def test_render_gated_bare_and_namespaced(
    operator_overlay: PolicyOverlay, name: str
) -> None:
    decision = operator_overlay.evaluate(name, {})
    assert decision.action == "ask_operator"
    assert decision.risk_class == "spend"


@pytest.mark.parametrize(
    "name",
    [
        "pipeline_operator_read",
        _NS + "pipeline_operator_read",
        "pipeline_operator_brief",
        _NS + "pipeline_operator_brief",
    ],
)
def test_read_brief_allowlisted_bare_and_namespaced(
    operator_overlay: PolicyOverlay, name: str
) -> None:
    decision = operator_overlay.evaluate(name, {})
    assert decision.action == "allow"


def test_blocklist_matches_namespaced_form() -> None:
    overlay = PolicyOverlay(
        allowlist=frozenset(),
        extra_requires_approval=frozenset(),
        blocklist=frozenset({"danger_tool"}),
    )
    bare = overlay.evaluate("danger_tool", {})
    namespaced = overlay.evaluate("mcp__some-server__danger_tool", {})
    assert bare.action == "block"
    assert namespaced.action == "block"


def test_namespace_match_is_anchored_on_double_underscore() -> None:
    """A suffix that is not a whole ``__``-delimited segment must NOT match.

    Entry ``render`` must NOT gate ``pipeline_operator_render`` (there is no
    ``__render`` boundary), so the match stays precise to namespaced segments.
    """
    overlay = PolicyOverlay(
        allowlist=frozenset(),
        extra_requires_approval=frozenset({"render"}),
        blocklist=frozenset(),
    )
    decision = overlay.evaluate("pipeline_operator_render", {})
    # Not gated by the overlay → falls through to the base engine, which treats
    # this unknown tool as risky (ask), but NOT because of the ``render`` entry.
    assert "policy overlay" not in decision.reason


def test_matches_helper_bare_and_namespaced() -> None:
    from voxhorizon_approvals.policy_overlay import _matches

    entries = frozenset({"pipeline_operator_render"})
    assert _matches("pipeline_operator_render", entries) is True
    assert (
        _matches(
            "mcp__pipeline-operator__pipeline_operator_render", entries
        )
        is True
    )
    assert _matches("pipeline_operator_read", entries) is False
    # Precise boundary: a non-``__`` suffix is not a match.
    assert _matches("xpipeline_operator_render", entries) is False


# ---------------------------------------------------------------------------
# The shipped file parses to exactly the intended sets
# ---------------------------------------------------------------------------


def test_shipped_operator_policy_contents() -> None:
    overlay = load_overlay(OPERATOR_POLICY_PATH)
    assert overlay.extra_requires_approval == frozenset(
        {"pipeline_operator_render"}
    )
    assert overlay.allowlist == frozenset(
        {"pipeline_operator_read", "pipeline_operator_brief"}
    )
    assert overlay.blocklist == frozenset()


# ---------------------------------------------------------------------------
# In-code defaults WIN over a softening overlay
# ---------------------------------------------------------------------------


def test_overlay_cannot_allowlist_away_requires_approval() -> None:
    """A tool baked into REQUIRES_APPROVAL stays gated even if allowlisted."""
    overlay = PolicyOverlay(
        allowlist=frozenset({"kie_generate"}),
        extra_requires_approval=frozenset(),
        blocklist=frozenset(),
    )
    decision = overlay.evaluate("kie_generate", {})
    assert decision.action == "ask_operator"
    assert decision.risk_class == "spend"


def test_overlay_cannot_allowlist_away_destructive_shell() -> None:
    """``rm -rf`` still asks even if ``shell_command`` is allowlisted."""
    overlay = PolicyOverlay(
        allowlist=frozenset({"shell_command"}),
        extra_requires_approval=frozenset(),
        blocklist=frozenset(),
    )
    decision = overlay.evaluate("shell_command", {"command": "rm -rf /opt"})
    assert decision.action == "ask_operator"
    assert "destructive" in decision.reason


def test_overlay_gating_wins_over_overlay_allowlist() -> None:
    """If a tool is in BOTH overlay sets, gating wins (safer)."""
    overlay = PolicyOverlay(
        allowlist=frozenset({"pipeline_operator_render"}),
        extra_requires_approval=frozenset({"pipeline_operator_render"}),
        blocklist=frozenset(),
    )
    decision = overlay.evaluate("pipeline_operator_render", {})
    assert decision.action == "ask_operator"


def test_blocklist_is_highest_precedence() -> None:
    overlay = PolicyOverlay(
        allowlist=frozenset({"some_tool"}),
        extra_requires_approval=frozenset({"some_tool"}),
        blocklist=frozenset({"some_tool"}),
    )
    decision = overlay.evaluate("some_tool", {})
    assert decision.action == "block"
    assert "blocklist" in decision.reason


# ---------------------------------------------------------------------------
# Safe tools and the read shell path still flow through the engine
# ---------------------------------------------------------------------------


def test_overlay_delegates_safe_shell(operator_overlay: PolicyOverlay) -> None:
    """A read-only shell command still flows through to the engine's allow."""
    decision = operator_overlay.evaluate("shell_command", {"command": "git status"})
    assert decision.action == "allow"


def test_overlay_delegates_in_code_allowlist(
    operator_overlay: PolicyOverlay,
) -> None:
    """Tools on the in-code ALLOWLIST keep working under the overlay."""
    decision = operator_overlay.evaluate("read_file", {"path": "/x"})
    assert decision.action == "allow"


def test_overlay_unknown_tool_fails_closed(
    operator_overlay: PolicyOverlay,
) -> None:
    decision = operator_overlay.evaluate("totally_made_up", {})
    assert decision.action == "ask_operator"
    assert decision.risk_class == "unknown"


# ---------------------------------------------------------------------------
# Empty overlay == pure pass-through (Ekko's behavior is unchanged)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "tool, args",
    [
        ("read_file", {"path": "/x"}),
        ("kie_generate", {"prompt": "x"}),
        ("shell_command", {"command": "git status"}),
        ("shell_command", {"command": "rm -rf /"}),
        ("delete_file", {"path": "/x"}),
        ("send_email", {"to": "x"}),
        ("totally_made_up", {}),
        ("pipeline_operator_render", {}),  # unknown to the base engine → asks
    ],
)
def test_empty_overlay_matches_plain_evaluate(tool: str, args: dict) -> None:
    """With an empty policy the overlay decision equals ``policy.evaluate``."""
    overlay = load_overlay(None)
    assert overlay.evaluate(tool, args) == evaluate(tool, args)


def test_missing_file_yields_empty_overlay(tmp_path: Path) -> None:
    overlay = load_overlay(tmp_path / "does-not-exist.yaml")
    assert overlay.allowlist == frozenset()
    assert overlay.extra_requires_approval == frozenset()
    assert overlay.blocklist == frozenset()


# ---------------------------------------------------------------------------
# The dependency-free YAML-subset parser (no PyYAML required)
# ---------------------------------------------------------------------------


def test_subset_parser_block_and_inline(tmp_path: Path) -> None:
    """The hand parser handles block lists, inline ``[]``, and comments."""
    from voxhorizon_approvals.policy_overlay import _parse_policy_subset

    text = (
        "# a comment\n"
        "extra_requires_approval:\n"
        "  - pipeline_operator_render  # gate spend\n"
        "allowlist:\n"
        "  - pipeline_operator_read\n"
        "  - 'pipeline_operator_brief'\n"
        "blocklist: []\n"
    )
    parsed = _parse_policy_subset(text)
    assert parsed["extra_requires_approval"] == ["pipeline_operator_render"]
    assert parsed["allowlist"] == [
        "pipeline_operator_read",
        "pipeline_operator_brief",
    ]
    assert parsed["blocklist"] == []


def test_subset_parser_inline_list(tmp_path: Path) -> None:
    from voxhorizon_approvals.policy_overlay import _parse_policy_subset

    parsed = _parse_policy_subset('allowlist: [a, "b", c]\n')
    assert parsed["allowlist"] == ["a", "b", "c"]


def test_subset_parser_ignores_unknown_keys() -> None:
    from voxhorizon_approvals.policy_overlay import _parse_policy_subset

    parsed = _parse_policy_subset("bogus_key: [x]\nallowlist: [y]\n")
    assert "bogus_key" not in parsed
    assert parsed["allowlist"] == ["y"]
