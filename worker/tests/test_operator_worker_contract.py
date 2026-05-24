"""Round-trip contract test: operator helper payloads vs worker pydantic models.

This is the regression guard for epic #486 (E3.1): the operator->worker
candidate path was schema-mismatched, so the HARD compliance gate and the QA
gate 422'd and never ran end to end. The operator helper
(``infra/hermes/operator/skills/pipeline-operator/helper.py``) posted compliance
as ``{candidates:[{creative_id, findings:[...]}]}`` and QA as
``{results:[{creative_id, verdict, scores, defects, ...}]}``, but the worker
route (``worker/src/routes/qa_compliance.py``) expects
``ComplianceRunInput{pipeline_id, items:[{creative_id, ..., llm_candidates:[...]}]}``
and ``QARunInput{pipeline_id, items:[{creative_id, ..., vision_candidates:[...]}]}``.

The canonical contract is the WORKER shape (it preserves the candidate/verdict
split: the operator submits CANDIDATES only and the worker writes the verdict).
This test loads the REAL operator helper module by file path and asserts that
the exact body its ``pipeline_operator_compliance_result`` /
``pipeline_operator_qa_result`` functions POST validates against the worker
pydantic models. If the helper drifts back to the old (verdict-shaped) payload,
the round-trip assertions fail and CI catches the drift before it 422s live.

The helper is imported by file path (not as an installed package) because it
lives in the operator skill tree, not the worker package; ``helper.py`` itself
imports only stdlib + ``httpx`` (a worker dependency), so the import is clean in
the worker venv. The relative path from this test pins the canonical source.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from pydantic import ValidationError

from src.routes.qa_compliance import ComplianceRunInput, QARunInput


PIPELINE_ID = "11111111-1111-4111-8111-111111111111"
CREATIVE_ID = "22222222-2222-4222-8222-222222222222"
COPY_VARIANT_ID = "44444444-4444-4444-8444-444444444444"


# ---------------------------------------------------------------------------
# Load the REAL operator helper by file path (the canonical source-of-truth).
# ---------------------------------------------------------------------------
#
# Pinned path: <repo-root>/infra/hermes/operator/skills/pipeline-operator/helper.py
# (relative to this file: worker/tests/ -> up two -> repo root). If the operator
# helper moves, this resolution fails loudly rather than silently skipping the
# contract check.
_HELPER_PATH = (
    Path(__file__).resolve().parents[2]
    / "infra"
    / "hermes"
    / "operator"
    / "skills"
    / "pipeline-operator"
    / "helper.py"
)


def _load_helper() -> ModuleType:
    """Import the operator helper module from its pinned file path."""
    assert _HELPER_PATH.is_file(), f"operator helper not found at {_HELPER_PATH}"
    spec = importlib.util.spec_from_file_location(
        "pipeline_operator_helper_under_test", _HELPER_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def helper() -> ModuleType:
    return _load_helper()


@pytest.fixture
def captured_post(
    helper: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> list[dict[str, Any]]:
    """Capture the body the helper POSTs without a network round-trip.

    Patches the helper's private ``_request`` so calling the public
    ``pipeline_operator_*`` functions exercises the full real code path (arg
    validation + payload construction) and records the JSON body it would send.
    """
    sent: list[dict[str, Any]] = []

    def fake_request(
        method: str, path: str, *, json_body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        sent.append({"method": method, "path": path, "json_body": json_body})
        return {"ok": True}

    monkeypatch.setattr(helper, "_request", fake_request)
    return sent


# ---------------------------------------------------------------------------
# Compliance round-trip
# ---------------------------------------------------------------------------


def test_compliance_helper_body_validates_against_worker_model(
    helper: ModuleType, captured_post: list[dict[str, Any]]
) -> None:
    """The exact body ``pipeline_operator_compliance_result`` POSTs is a valid
    ``ComplianceRunInput`` (this is the fix; pre-fix it 422'd)."""
    # The shape the operator's compliance specialist produces (SKILL.md):
    # {creative_id, findings:[{rule_id, version, label, confidence,
    #  evidence_span, required_edit, citation_url}]} plus the engine-context
    # passthroughs the worker needs.
    helper.pipeline_operator_compliance_result(
        pipeline_id=PIPELINE_ID,
        candidates=[
            {
                "creative_id": CREATIVE_ID,
                "copy_variant_id": COPY_VARIANT_ID,
                "surface": "copy",
                "vertical": "roofing",
                "findings": [
                    {
                        "rule_id": "meta.personal_attributes",
                        "version": "2025.1",
                        "label": "clear",
                        "confidence": 0.92,
                        "evidence_span": "headline reads ...",
                        "required_edit": None,
                        "citation_url": "https://example/policy",
                    }
                ],
            }
        ],
    )

    assert len(captured_post) == 1
    call = captured_post[0]
    assert call["path"].endswith("/compliance_run")
    body = call["json_body"]
    assert body is not None

    # The load-bearing assertion: the body validates against the worker model.
    model = ComplianceRunInput.model_validate(body)
    assert model.pipeline_id == PIPELINE_ID
    assert len(model.items) == 1
    item = model.items[0]
    assert item.creative_id == CREATIVE_ID
    assert item.copy_variant_id == COPY_VARIANT_ID
    assert item.surface == "copy"
    assert item.vertical == "roofing"
    # Findings landed under llm_candidates (the canonical key), not "findings".
    assert "findings" not in body["items"][0]
    assert len(item.llm_candidates) == 1
    cand = item.llm_candidates[0]
    assert cand.rule_id == "meta.personal_attributes"
    assert cand.label == "clear"
    assert cand.confidence == 0.92
    assert cand.evidence_span == "headline reads ..."
    # extra="allow": the version (+ citation) ride along on the candidate.
    assert cand.model_dump().get("version") == "2025.1"


def test_compliance_helper_minimal_body_validates(
    helper: ModuleType, captured_post: list[dict[str, Any]]
) -> None:
    """A minimal candidate (creative_id only, no findings) still validates."""
    helper.pipeline_operator_compliance_result(
        pipeline_id=PIPELINE_ID,
        candidates=[{"creative_id": CREATIVE_ID}],
    )
    body = captured_post[0]["json_body"]
    model = ComplianceRunInput.model_validate(body)
    assert model.items[0].creative_id == CREATIVE_ID
    assert model.items[0].llm_candidates == []
    # surface defaults to "copy" in the worker model when the operator omits it.
    assert model.items[0].surface == "copy"


def test_compliance_old_shape_would_fail_validation() -> None:
    """REGRESSION PIN: the pre-fix helper body (``candidates``/``findings``)
    does NOT validate against the worker model.

    This is the bug the PR fixes. The old helper posted
    ``{pipeline_id, candidates:[{creative_id, findings:[...]}]}``; the worker
    requires ``items`` (min_length=1), so the old body 422'd and the HARD
    compliance gate never ran. If a future change reintroduces this shape, this
    test fails.
    """
    old_body = {
        "pipeline_id": PIPELINE_ID,
        "candidates": [
            {
                "creative_id": CREATIVE_ID,
                "findings": [{"rule_id": "meta.pa", "label": "clear"}],
            }
        ],
    }
    with pytest.raises(ValidationError):
        ComplianceRunInput.model_validate(old_body)


# ---------------------------------------------------------------------------
# QA round-trip
# ---------------------------------------------------------------------------


def test_qa_helper_body_validates_against_worker_model(
    helper: ModuleType, captured_post: list[dict[str, Any]]
) -> None:
    """The exact body ``pipeline_operator_qa_result`` POSTs is a valid
    ``QARunInput`` (the fix; pre-fix it 422'd)."""
    helper.pipeline_operator_qa_result(
        pipeline_id=PIPELINE_ID,
        results=[
            {
                "creative_id": CREATIVE_ID,
                "ratio": "1x1",
                "vertical": "roofing",
                "vision_candidates": [
                    {"check_id": "vision.hands", "score": 0.95},
                    {"check_id": "vision.text_glyphs", "score": 0.9, "note": "ok"},
                ],
            }
        ],
    )

    assert len(captured_post) == 1
    call = captured_post[0]
    assert call["path"].endswith("/qa_run")
    body = call["json_body"]
    assert body is not None

    model = QARunInput.model_validate(body)
    assert model.pipeline_id == PIPELINE_ID
    assert len(model.items) == 1
    item = model.items[0]
    assert item.creative_id == CREATIVE_ID
    assert item.ratio == "1x1"
    assert item.vertical == "roofing"
    assert len(item.vision_candidates) == 2
    assert item.vision_candidates[0].check_id == "vision.hands"
    assert item.vision_candidates[0].score == 0.95


def test_qa_helper_drops_verdict_keys_preserving_invariant(
    helper: ModuleType, captured_post: list[dict[str, Any]]
) -> None:
    """INVARIANT: the operator must NOT send a verdict the worker trusts.

    Even when the specialist hands the helper the legacy verdict-shaped result
    (``verdict``/``scores``/``defects``/``remediation``), the helper forwards
    only candidate/context fields. The posted body carries no verdict key and
    validates as a candidate-only ``QAItem`` (the worker writes the verdict).
    """
    helper.pipeline_operator_qa_result(
        pipeline_id=PIPELINE_ID,
        results=[
            {
                "creative_id": CREATIVE_ID,
                "ratio": "1x1",
                # Legacy verdict-shaped keys the specialist might still emit:
                "verdict": "pass",
                "scores": {"hands": 0.95, "anatomy": 0.9},
                "defects": [],
                "remediation": "none",
                "vision_candidates": [{"check_id": "vision.hands", "score": 0.95}],
            }
        ],
    )
    body = captured_post[0]["json_body"]
    item = body["items"][0]
    # No verdict-writing keys leak to the worker.
    for forbidden in ("verdict", "scores", "defects", "remediation"):
        assert forbidden not in item
    # And it still validates as a candidate-only item.
    QARunInput.model_validate(body)


def test_qa_helper_defaults_ratio(
    helper: ModuleType, captured_post: list[dict[str, Any]]
) -> None:
    """A result without ``ratio`` gets the worker default (``1x1``)."""
    helper.pipeline_operator_qa_result(
        pipeline_id=PIPELINE_ID,
        results=[{"creative_id": CREATIVE_ID}],
    )
    body = captured_post[0]["json_body"]
    model = QARunInput.model_validate(body)
    assert model.items[0].ratio == "1x1"
    assert model.items[0].vision_candidates == []


def test_qa_old_shape_would_fail_validation() -> None:
    """REGRESSION PIN: the pre-fix helper body (``results``/``verdict``) does
    NOT validate against the worker model.

    The old helper posted ``{pipeline_id, results:[{creative_id, verdict,
    scores, ...}]}``; the worker requires ``items`` (min_length=1), so the old
    body 422'd and the QA gate never ran.
    """
    old_body = {
        "pipeline_id": PIPELINE_ID,
        "results": [
            {"creative_id": CREATIVE_ID, "verdict": "pass", "scores": {}},
        ],
    }
    with pytest.raises(ValidationError):
        QARunInput.model_validate(old_body)
