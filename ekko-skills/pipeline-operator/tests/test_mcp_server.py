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
# Registration: the four tools, under the gating-canonical names
# ---------------------------------------------------------------------------

EXPECTED_TOOLS = {
    "pipeline_operator_read",
    "pipeline_operator_client_read",
    "pipeline_operator_brief",
    "pipeline_operator_render",
    # P3 stage-persist tools (all allowlisted; none clears a gate).
    "pipeline_operator_qa_result",
    "pipeline_operator_compliance_result",
    "pipeline_operator_copy",
    "pipeline_operator_spec_result",
    "pipeline_operator_finalize_result",
    "pipeline_operator_monitor_result",
    "pipeline_operator_signal",
}


def _list_tools() -> list:
    return asyncio.run(mcp_server.mcp.list_tools())


def test_server_name_is_pipeline_operator() -> None:
    assert mcp_server.SERVER_NAME == "pipeline-operator"
    assert mcp_server.mcp.name == "pipeline-operator"


def test_exactly_expected_tools_registered() -> None:
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
    assert {"pipeline_id", "image_payload", "notes", "concepts"} <= set(
        brief_props
    )

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

    def fake_brief(*, pipeline_id, image_payload, notes=None, concepts=None):
        captured["pipeline_id"] = pipeline_id
        captured["image_payload"] = image_payload
        captured["notes"] = notes
        captured["concepts"] = concepts
        return sentinel

    monkeypatch.setattr(helper, "pipeline_operator_brief", fake_brief)

    payload = {"market": "us", "offer_text": "$99", "angles": ["a"]}
    concepts = [{"concept": "before_after__x", "prompt": "p1"}]
    result = mcp_server.pipeline_operator_brief(
        "p-123", payload, notes="sharpened the offer", concepts=concepts
    )

    assert captured == {
        "pipeline_id": "p-123",
        "image_payload": payload,
        "notes": "sharpened the offer",
        "concepts": concepts,
    }
    assert result is sentinel


def test_brief_defaults_notes_and_concepts_to_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def fake_brief(*, pipeline_id, image_payload, notes=None, concepts=None):
        captured["notes"] = notes
        captured["concepts"] = concepts
        return {"ok": True}

    monkeypatch.setattr(helper, "pipeline_operator_brief", fake_brief)

    mcp_server.pipeline_operator_brief(
        "p-1", {"market": "us", "offer_text": "x", "angles": ["a"]}
    )
    assert captured["notes"] is None
    assert captured["concepts"] is None


def test_render_delegates_to_helper_with_kwargs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}
    sentinel = {"ok": True, "renders": [], "total_cost_usd": 0.0, "errors": []}

    def fake_render(*, pipeline_id, kind, items=None):
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


def test_render_deterministic_defaults_items_to_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The deterministic dispatch omits items; the server forwards None so the
    helper renders the persisted plan."""
    captured: dict = {}

    def fake_render(*, pipeline_id, kind, items=None):
        captured["items"] = items
        return {"ok": True, "renders": [], "total_cost_usd": 0, "errors": []}

    monkeypatch.setattr(helper, "pipeline_operator_render", fake_render)

    mcp_server.pipeline_operator_render("p-9", "concept_preview")
    assert captured["items"] is None


def test_render_passes_errors_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The server does not swallow helper validation errors — they propagate
    so the MCP layer reports them to the agent."""

    def fake_render(*, pipeline_id, kind, items=None):
        raise helper.PipelineOperatorError("bad kind")

    monkeypatch.setattr(helper, "pipeline_operator_render", fake_render)

    with pytest.raises(helper.PipelineOperatorError):
        mcp_server.pipeline_operator_render("p-1", "nope", [{}])


def test_brief_docstring_documents_concepts_first_contract() -> None:
    """The brief tool advertises the relaxed contract: market is required plus
    EITHER a concepts list OR offer_text+angles, and concept_name is accepted."""
    doc = mcp_server.pipeline_operator_brief.__doc__ or ""
    assert "market" in doc
    assert "concepts" in doc
    assert "offer_text" in doc and "angles" in doc
    assert "concept_name" in doc


# ---------------------------------------------------------------------------
# P3 stage-persist tools: registration + delegation
# ---------------------------------------------------------------------------


def test_launch_tool_is_not_registered_here() -> None:
    """The Meta launch tool requires approval and is the integrations agent's —
    it must NOT be advertised by this server (so the gate isn't bypassed)."""
    names = {t.name for t in _list_tools()}
    assert "pipeline_operator_launch" not in names


def test_stage_persist_tools_have_array_params() -> None:
    schemas = {t.name: t.inputSchema for t in _list_tools()}
    for name, array_key in (
        ("pipeline_operator_qa_result", "results"),
        ("pipeline_operator_compliance_result", "candidates"),
        ("pipeline_operator_copy", "variants"),
        ("pipeline_operator_spec_result", "results"),
        ("pipeline_operator_finalize_result", "results"),
        ("pipeline_operator_monitor_result", "results"),
    ):
        props = set(schemas[name].get("properties", {}))
        assert {"pipeline_id", array_key} <= props
    signal_props = set(schemas["pipeline_operator_signal"].get("properties", {}))
    assert {"pipeline_id", "dispatch_id", "status"} <= signal_props


def test_qa_result_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def fake(*, pipeline_id, results):
        captured["pipeline_id"] = pipeline_id
        captured["results"] = results
        return {"ok": True}

    monkeypatch.setattr(helper, "pipeline_operator_qa_result", fake)
    out = mcp_server.pipeline_operator_qa_result("p-1", [{"creative_id": "cr-1"}])
    assert captured == {"pipeline_id": "p-1", "results": [{"creative_id": "cr-1"}]}
    assert out == {"ok": True}


def test_compliance_result_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def fake(*, pipeline_id, candidates):
        captured["pipeline_id"] = pipeline_id
        captured["candidates"] = candidates
        return {"ok": True}

    monkeypatch.setattr(helper, "pipeline_operator_compliance_result", fake)
    mcp_server.pipeline_operator_compliance_result("p-1", [{"creative_id": "cr-1"}])
    assert captured == {"pipeline_id": "p-1", "candidates": [{"creative_id": "cr-1"}]}


def test_copy_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def fake(*, pipeline_id, variants):
        captured["pipeline_id"] = pipeline_id
        captured["variants"] = variants
        return {"ok": True}

    monkeypatch.setattr(helper, "pipeline_operator_copy", fake)
    mcp_server.pipeline_operator_copy("p-1", [{"creative_id": "cr-1"}])
    assert captured == {"pipeline_id": "p-1", "variants": [{"creative_id": "cr-1"}]}


def test_spec_result_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def fake(*, pipeline_id, results):
        captured["results"] = results
        return {"ok": True}

    monkeypatch.setattr(helper, "pipeline_operator_spec_result", fake)
    mcp_server.pipeline_operator_spec_result("p-1", [{"creative_id": "cr-1"}])
    assert captured["results"] == [{"creative_id": "cr-1"}]


def test_finalize_result_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def fake(*, pipeline_id, results):
        captured["results"] = results
        return {"ok": True}

    monkeypatch.setattr(helper, "pipeline_operator_finalize_result", fake)
    mcp_server.pipeline_operator_finalize_result("p-1", [{"creative_id": "cr-1"}])
    assert captured["results"] == [{"creative_id": "cr-1"}]


def test_monitor_result_delegates_with_client_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def fake(*, pipeline_id, results, client_id=None):
        captured["pipeline_id"] = pipeline_id
        captured["results"] = results
        captured["client_id"] = client_id
        return {"ok": True}

    monkeypatch.setattr(helper, "pipeline_operator_monitor_result", fake)
    mcp_server.pipeline_operator_monitor_result(
        "p-1", [{"campaign_id": "c"}], client_id="cl-1"
    )
    assert captured == {
        "pipeline_id": "p-1",
        "results": [{"campaign_id": "c"}],
        "client_id": "cl-1",
    }


def test_monitor_result_defaults_client_id_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def fake(*, pipeline_id, results, client_id=None):
        captured["client_id"] = client_id
        return {"ok": True}

    monkeypatch.setattr(helper, "pipeline_operator_monitor_result", fake)
    mcp_server.pipeline_operator_monitor_result("p-1", [{"campaign_id": "c"}])
    assert captured["client_id"] is None


def test_signal_delegates_full_kwargs(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def fake(
        *,
        pipeline_id,
        dispatch_id,
        status,
        stage=None,
        expected_status=None,
        exec_id=None,
        summary=None,
        error=None,
    ):
        captured.update(
            pipeline_id=pipeline_id,
            dispatch_id=dispatch_id,
            status=status,
            stage=stage,
            expected_status=expected_status,
            exec_id=exec_id,
            summary=summary,
            error=error,
        )
        return {"ok": True}

    monkeypatch.setattr(helper, "pipeline_operator_signal", fake)
    mcp_server.pipeline_operator_signal(
        "p-1", "d-1", "completed", stage="copy", expected_status="copy", summary="done"
    )
    assert captured["pipeline_id"] == "p-1"
    assert captured["dispatch_id"] == "d-1"
    assert captured["status"] == "completed"
    assert captured["stage"] == "copy"
    assert captured["summary"] == "done"
    assert captured["error"] is None


def test_signal_propagates_helper_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake(**_kw):
        raise helper.PipelineOperatorError("bad status")

    monkeypatch.setattr(helper, "pipeline_operator_signal", fake)
    with pytest.raises(helper.PipelineOperatorError):
        mcp_server.pipeline_operator_signal("p-1", "d-1", "boom")
