"""Tests for the pipeline-operator MCP server (``mcp_server.py``).

The server is a thin transport over ``helper.py``: each MCP tool delegates
straight to the matching helper function (single source of truth). These tests
therefore prove two things and nothing more:

* **Registration** — exactly the three tools (``pipeline_operator_read`` /
  ``_brief`` / ``_render``) are advertised, under those exact names, with the
  expected parameters in their input schema.
* **Delegation** — calling each tool function forwards its arguments verbatim
  to the corresponding ``helper`` function and returns the helper's result.
  We patch the ``helper`` functions so no HTTP happens.

If the official ``mcp`` SDK is not importable in this environment, the whole
module is skipped (the server code stays standard regardless).
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

SKILL_DIR = Path(__file__).resolve().parent.parent
if str(SKILL_DIR) not in sys.path:
    sys.path.insert(0, str(SKILL_DIR))

# The MCP SDK is the only hard dependency of the server beyond helper.py. If it
# isn't installed (e.g. a fully offline test box), skip rather than error — the
# server itself remains a normal stdio MCP server.
mcp_server = pytest.importorskip(
    "mcp_server",
    reason="the `mcp` SDK is not installed in this environment",
)

import helper  # noqa: E402


# ---------------------------------------------------------------------------
# Registration: exactly three tools, under the gating-canonical names
# ---------------------------------------------------------------------------

EXPECTED_TOOLS = {
    "pipeline_operator_read",
    "pipeline_operator_brief",
    "pipeline_operator_render",
}


def _list_tools() -> list:
    return asyncio.run(mcp_server.mcp.list_tools())


def test_server_name_is_pipeline_operator() -> None:
    assert mcp_server.SERVER_NAME == "pipeline-operator"
    assert mcp_server.mcp.name == "pipeline-operator"


def test_exactly_three_tools_registered() -> None:
    names = {t.name for t in _list_tools()}
    assert names == EXPECTED_TOOLS


def test_render_tool_is_advertised_by_its_gating_name() -> None:
    """The spend tool MUST surface under ``pipeline_operator_render`` so the
    approval overlay can gate it by name."""
    names = {t.name for t in _list_tools()}
    assert "pipeline_operator_render" in names


def test_each_tool_has_a_description() -> None:
    for tool in _list_tools():
        assert tool.description and tool.description.strip()


def test_tool_input_schemas_expose_expected_params() -> None:
    by_name = {t.name for t in _list_tools()}
    assert EXPECTED_TOOLS <= by_name

    schemas = {t.name: t.inputSchema for t in _list_tools()}

    read_props = schemas["pipeline_operator_read"].get("properties", {})
    assert "pipeline_id" in read_props

    brief_props = schemas["pipeline_operator_brief"].get("properties", {})
    assert {"pipeline_id", "image_payload", "notes"} <= set(brief_props)

    render_props = schemas["pipeline_operator_render"].get("properties", {})
    assert {"pipeline_id", "kind", "items"} <= set(render_props)


# ---------------------------------------------------------------------------
# Delegation: each tool forwards to the matching helper function
# ---------------------------------------------------------------------------


def test_read_delegates_to_helper(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    sentinel = {"status": "ideation"}

    def fake_read(pipeline_id: str):
        calls.append(pipeline_id)
        return sentinel

    monkeypatch.setattr(helper, "pipeline_operator_read", fake_read)

    result = mcp_server.pipeline_operator_read("p-123")

    assert calls == ["p-123"]
    assert result is sentinel


def test_brief_delegates_to_helper_with_kwargs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}
    sentinel = {"ok": True, "brief_id": "b-1"}

    def fake_brief(*, pipeline_id, image_payload, notes=None):
        captured["pipeline_id"] = pipeline_id
        captured["image_payload"] = image_payload
        captured["notes"] = notes
        return sentinel

    monkeypatch.setattr(helper, "pipeline_operator_brief", fake_brief)

    payload = {"market": "us", "offer_text": "$99", "angles": ["a"]}
    result = mcp_server.pipeline_operator_brief(
        "p-123", payload, notes="sharpened the offer"
    )

    assert captured == {
        "pipeline_id": "p-123",
        "image_payload": payload,
        "notes": "sharpened the offer",
    }
    assert result is sentinel


def test_brief_defaults_notes_to_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def fake_brief(*, pipeline_id, image_payload, notes=None):
        captured["notes"] = notes
        return {"ok": True}

    monkeypatch.setattr(helper, "pipeline_operator_brief", fake_brief)

    mcp_server.pipeline_operator_brief(
        "p-1", {"market": "us", "offer_text": "x", "angles": ["a"]}
    )
    assert captured["notes"] is None


def test_render_delegates_to_helper_with_kwargs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}
    sentinel = {"ok": True, "renders": [], "total_cost_usd": 0.0, "errors": []}

    def fake_render(*, pipeline_id, kind, items):
        captured["pipeline_id"] = pipeline_id
        captured["kind"] = kind
        captured["items"] = items
        return sentinel

    monkeypatch.setattr(helper, "pipeline_operator_render", fake_render)

    items = [{"concept": "c1", "prompt": "p1"}]
    result = mcp_server.pipeline_operator_render("p-9", "concept_preview", items)

    assert captured == {
        "pipeline_id": "p-9",
        "kind": "concept_preview",
        "items": items,
    }
    assert result is sentinel


def test_render_passes_errors_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The server does not swallow helper validation errors — they propagate
    so the MCP layer reports them to the agent."""

    def fake_render(*, pipeline_id, kind, items):
        raise helper.PipelineOperatorError("bad kind")

    monkeypatch.setattr(helper, "pipeline_operator_render", fake_render)

    with pytest.raises(helper.PipelineOperatorError):
        mcp_server.pipeline_operator_render("p-1", "nope", [{}])
