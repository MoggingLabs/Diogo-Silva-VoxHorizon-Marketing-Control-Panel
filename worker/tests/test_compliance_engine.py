"""Tests for the compliance engine (P2.1 / #339).

Covers each ``check_spec`` type (``regex_any`` / ``field_predicate`` /
``llm_classify``), the LLM-candidate adjudication + escalation invariant
(uncertain / low-confidence -> ``needs_review``, never auto-pass), the
per-client ``do_not_say`` synthesis, vertical scoping, and the verdict
roll-up.
"""

from __future__ import annotations

import pytest

from src.services import compliance_engine as eng
from src.services.compliance_engine import (
    DEFAULT_MIN_CONFIDENCE,
    EvaluationResult,
    Finding,
    evaluate,
    synthesize_do_not_say_rules,
)


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


def _context(
    *,
    headline: str = "",
    body: str = "",
    description: str = "",
    cta: str = "",
    service_type: str = "roofing",
    offer_constraints: list | None = None,
    creative: dict | None = None,
    copy_is_none: bool = False,
    surface: str = "copy",
) -> dict:
    return {
        "creative": creative or {"id": "img-01"},
        "copy": None
        if copy_is_none
        else {
            "headline": headline,
            "body": body,
            "description": description,
            "cta": cta,
        },
        "client": {
            "service_type": service_type,
            "offer_constraints": offer_constraints or [],
        },
        "surface": surface,
    }


def _finding(result: EvaluationResult, rule_id: str) -> Finding:
    for f in result.findings:
        if f.rule_id == rule_id:
            return f
    raise AssertionError(f"no finding for {rule_id}: {[f.rule_id for f in result.findings]}")


# A tiny single-rule ruleset for focused tests, so each check_spec type is
# exercised in isolation without the whole starter set.
def _regex_rule(**over) -> dict:
    base = {
        "rule_id": "t.regex",
        "version": "1",
        "title": "regex test rule",
        "applies_to_vertical": ["*"],
        "surface": "copy",
        "severity": "block",
        "engine": "deterministic",
        "check_spec": {
            "type": "regex_any",
            "fields": ["headline", "body"],
            "patterns": [r"\bbadword\b"],
        },
        "required_edit": "remove it",
        "citation_url": "http://example.test/regex",
    }
    base.update(over)
    return base


# ---------------------------------------------------------------------------
# regex_any
# ---------------------------------------------------------------------------


def test_regex_any_fires_on_match() -> None:
    ctx = _context(headline="this is a badword headline")
    result = evaluate(ctx, rules=[_regex_rule()])
    f = _finding(result, "t.regex")
    assert f.verdict == "fail"
    assert "badword" in f.evidence
    assert result.overall_verdict == "fail"


def test_regex_any_passes_on_no_match() -> None:
    ctx = _context(headline="all clean here")
    result = evaluate(ctx, rules=[_regex_rule()])
    assert _finding(result, "t.regex").verdict == "pass"
    assert result.overall_verdict == "pass"


def test_regex_any_is_case_insensitive() -> None:
    ctx = _context(body="A BADWORD shouts")
    result = evaluate(ctx, rules=[_regex_rule()])
    assert _finding(result, "t.regex").verdict == "fail"


def test_regex_any_skips_field_not_in_copy() -> None:
    # 'description' is not in the rule's fields list -> not searched.
    ctx = _context(description="badword lives only in description")
    result = evaluate(ctx, rules=[_regex_rule()])
    assert _finding(result, "t.regex").verdict == "pass"


def test_regex_any_with_none_copy_does_not_match() -> None:
    ctx = _context(copy_is_none=True)
    result = evaluate(ctx, rules=[_regex_rule()])
    assert _finding(result, "t.regex").verdict == "pass"


def test_regex_any_resolves_creative_attribute_field() -> None:
    # A field not in copy nor a derived predicate resolves from creative.
    rule = _regex_rule(check_spec={
        "type": "regex_any",
        "fields": ["alt_text"],
        "patterns": [r"\bbadword\b"],
    })
    ctx = _context(creative={"id": "img-01", "alt_text": "a badword in alt"})
    result = evaluate(ctx, rules=[rule])
    assert _finding(result, "t.regex").verdict == "fail"


def test_regex_any_creative_field_missing_is_skipped() -> None:
    rule = _regex_rule(check_spec={
        "type": "regex_any",
        "fields": ["alt_text"],
        "patterns": [r"\bbadword\b"],
    })
    ctx = _context(creative={"id": "img-01"})  # no alt_text
    result = evaluate(ctx, rules=[rule])
    assert _finding(result, "t.regex").verdict == "pass"


# ---------------------------------------------------------------------------
# field_predicate
# ---------------------------------------------------------------------------


def _predicate_rule(**spec_over) -> dict:
    spec = {
        "type": "field_predicate",
        "field": "has_overlay_text",
        "equals": True,
        "then_require": None,
    }
    spec.update(spec_over)
    return {
        "rule_id": "t.predicate",
        "version": "1",
        "title": "predicate test rule",
        "applies_to_vertical": ["*"],
        "surface": "image",
        "severity": "warn",
        "engine": "deterministic",
        "check_spec": spec,
        "required_edit": "fix it",
        "citation_url": "http://example.test/pred",
    }


def test_field_predicate_fires_when_condition_is_the_violation() -> None:
    ctx = _context(creative={"id": "x", "has_overlay_text": True})
    result = evaluate(ctx, rules=[_predicate_rule()])
    f = _finding(result, "t.predicate")
    assert f.verdict == "fail"
    assert "has_overlay_text" in f.evidence


def test_field_predicate_does_not_fire_when_condition_absent() -> None:
    ctx = _context(creative={"id": "x", "has_overlay_text": False})
    result = evaluate(ctx, rules=[_predicate_rule()])
    assert _finding(result, "t.predicate").verdict == "pass"


def test_field_predicate_then_require_present_passes() -> None:
    # guarantee terms present AND disclosure present -> pass.
    rule = _predicate_rule(
        field="guarantee_terms_present",
        equals=True,
        then_require="guarantee_disclosure_present",
    )
    ctx = _context(
        headline="Lifetime warranty on every roof",
        body="See terms for details.",
    )
    result = evaluate(ctx, rules=[rule])
    assert _finding(result, "t.predicate").verdict == "pass"


def test_field_predicate_then_require_missing_fails() -> None:
    rule = _predicate_rule(
        field="guarantee_terms_present",
        equals=True,
        then_require="guarantee_disclosure_present",
    )
    ctx = _context(headline="Lifetime warranty on every roof")  # no disclosure
    result = evaluate(ctx, rules=[rule])
    f = _finding(result, "t.predicate")
    assert f.verdict == "fail"
    assert "missing" in f.evidence


def test_field_predicate_string_equals() -> None:
    rule = _predicate_rule(field="cta", equals="Buy now", then_require=None)
    ctx = _context(cta="Buy now")
    result = evaluate(ctx, rules=[rule])
    assert _finding(result, "t.predicate").verdict == "fail"


# ---------------------------------------------------------------------------
# llm adjudication + escalation
# ---------------------------------------------------------------------------


def _llm_rule(*, min_confidence: float | None = None, engine: str = "llm") -> dict:
    spec: dict = {"type": "llm_classify", "question": "is it bad?", "labels": ["violation", "clear", "uncertain"]}
    if min_confidence is not None:
        spec["min_confidence"] = min_confidence
    return {
        "rule_id": "t.llm",
        "version": "1",
        "title": "llm test rule",
        "applies_to_vertical": ["*"],
        "surface": "copy",
        "severity": "block",
        "engine": engine,
        "check_spec": spec,
        "required_edit": "fix it",
        "citation_url": "http://example.test/llm",
    }


def test_llm_confident_violation_fails() -> None:
    ctx = _context()
    cands = [{"rule_id": "t.llm", "label": "violation", "confidence": 0.95, "evidence_span": "bad"}]
    result = evaluate(ctx, llm_candidates=cands, rules=[_llm_rule(min_confidence=0.7)])
    f = _finding(result, "t.llm")
    assert f.verdict == "fail"
    assert "0.95" in f.evidence
    assert result.overall_verdict == "fail"


def test_llm_low_confidence_violation_escalates() -> None:
    ctx = _context()
    cands = [{"rule_id": "t.llm", "label": "violation", "confidence": 0.4}]
    result = evaluate(ctx, llm_candidates=cands, rules=[_llm_rule(min_confidence=0.7)])
    assert _finding(result, "t.llm").verdict == "needs_review"
    assert result.overall_verdict == "needs_review"


def test_llm_uncertain_escalates_never_passes() -> None:
    ctx = _context()
    cands = [{"rule_id": "t.llm", "label": "uncertain", "confidence": 0.99}]
    result = evaluate(ctx, llm_candidates=cands, rules=[_llm_rule()])
    assert _finding(result, "t.llm").verdict == "needs_review"


def test_llm_clear_passes() -> None:
    ctx = _context()
    cands = [{"rule_id": "t.llm", "label": "clear", "confidence": 0.9, "evidence_span": "ok"}]
    result = evaluate(ctx, llm_candidates=cands, rules=[_llm_rule()])
    f = _finding(result, "t.llm")
    assert f.verdict == "pass"
    assert "clear" in f.evidence


def test_llm_only_rule_with_no_candidate_escalates() -> None:
    # An unscreened pure-llm rule must never silently pass.
    ctx = _context()
    result = evaluate(ctx, llm_candidates=None, rules=[_llm_rule()])
    f = _finding(result, "t.llm")
    assert f.verdict == "needs_review"
    assert "no candidate" in f.evidence


def test_llm_unknown_label_treated_as_uncertain() -> None:
    ctx = _context()
    cands = [{"rule_id": "t.llm", "label": "weird", "confidence": 0.9}]
    result = evaluate(ctx, llm_candidates=cands, rules=[_llm_rule()])
    assert _finding(result, "t.llm").verdict == "needs_review"


def test_llm_confident_violation_wins_over_earlier_uncertain() -> None:
    ctx = _context()
    cands = [
        {"rule_id": "t.llm", "label": "uncertain", "confidence": 0.5},
        {"rule_id": "t.llm", "label": "violation", "confidence": 0.99, "evidence_span": "x"},
    ]
    result = evaluate(ctx, llm_candidates=cands, rules=[_llm_rule(min_confidence=0.7)])
    assert _finding(result, "t.llm").verdict == "fail"


def test_llm_default_min_confidence_applies_when_unset() -> None:
    ctx = _context()
    # Just under the default floor -> escalate (no explicit min_confidence).
    cands = [{"rule_id": "t.llm", "label": "violation", "confidence": DEFAULT_MIN_CONFIDENCE - 0.01}]
    result = evaluate(ctx, llm_candidates=cands, rules=[_llm_rule()])
    assert _finding(result, "t.llm").verdict == "needs_review"


def test_llm_malformed_confidence_is_conservative() -> None:
    ctx = _context()
    cands = [{"rule_id": "t.llm", "label": "violation", "confidence": "not-a-number"}]
    result = evaluate(ctx, llm_candidates=cands, rules=[_llm_rule(min_confidence=0.7)])
    # 0.0 confidence < floor -> escalate, not fail.
    assert _finding(result, "t.llm").verdict == "needs_review"


def test_llm_confidence_clamped_above_one() -> None:
    ctx = _context()
    cands = [{"rule_id": "t.llm", "label": "violation", "confidence": 5.0}]
    result = evaluate(ctx, llm_candidates=cands, rules=[_llm_rule(min_confidence=0.7)])
    assert _finding(result, "t.llm").verdict == "fail"


def test_llm_negative_confidence_clamped_to_zero() -> None:
    ctx = _context()
    cands = [{"rule_id": "t.llm", "label": "violation", "confidence": -3.0}]
    result = evaluate(ctx, llm_candidates=cands, rules=[_llm_rule(min_confidence=0.7)])
    assert _finding(result, "t.llm").verdict == "needs_review"


def test_candidate_without_rule_id_is_ignored() -> None:
    ctx = _context()
    cands = [{"label": "violation", "confidence": 0.99}]
    result = evaluate(ctx, llm_candidates=cands, rules=[_llm_rule()])
    # No candidate matched the rule -> unscreened llm rule escalates.
    assert _finding(result, "t.llm").verdict == "needs_review"


def test_clear_candidate_does_not_downgrade_escalation() -> None:
    ctx = _context()
    cands = [
        {"rule_id": "t.llm", "label": "uncertain", "confidence": 0.5},
        {"rule_id": "t.llm", "label": "clear", "confidence": 0.9},
    ]
    result = evaluate(ctx, llm_candidates=cands, rules=[_llm_rule()])
    assert _finding(result, "t.llm").verdict == "needs_review"


# ---------------------------------------------------------------------------
# both-engine combination (deterministic + llm, worst wins)
# ---------------------------------------------------------------------------


def test_both_engine_deterministic_pass_llm_absent_does_not_escalate() -> None:
    # A 'both' rule with a clean deterministic side and NO candidate must NOT
    # escalate — the deterministic backstop is authoritative when unscreened.
    rule = _regex_rule(engine="both")
    ctx = _context(headline="totally clean copy")
    result = evaluate(ctx, llm_candidates=None, rules=[rule])
    assert _finding(result, "t.regex").verdict == "pass"


def test_both_engine_llm_escalates_over_deterministic_pass() -> None:
    rule = _regex_rule(engine="both")
    ctx = _context(headline="clean")
    cands = [{"rule_id": "t.regex", "label": "uncertain", "confidence": 0.5}]
    result = evaluate(ctx, llm_candidates=cands, rules=[rule])
    assert _finding(result, "t.regex").verdict == "needs_review"


def test_both_engine_deterministic_fail_wins_over_llm_clear() -> None:
    rule = _regex_rule(engine="both")
    ctx = _context(headline="a badword here")
    cands = [{"rule_id": "t.regex", "label": "clear", "confidence": 0.99}]
    result = evaluate(ctx, llm_candidates=cands, rules=[rule])
    assert _finding(result, "t.regex").verdict == "fail"


# ---------------------------------------------------------------------------
# vertical scoping
# ---------------------------------------------------------------------------


def test_rule_skipped_when_vertical_does_not_apply() -> None:
    rule = _regex_rule(applies_to_vertical=["health"])
    ctx = _context(headline="badword", service_type="roofing")
    result = evaluate(ctx, rules=[rule])
    assert all(f.rule_id != "t.regex" for f in result.findings)
    assert result.overall_verdict == "pass"


def test_rule_applies_when_vertical_matches_case_insensitively() -> None:
    rule = _regex_rule(applies_to_vertical=["Health", "Cosmetic"])
    ctx = _context(headline="badword", service_type="HEALTH")
    result = evaluate(ctx, rules=[rule])
    assert _finding(result, "t.regex").verdict == "fail"


def test_wildcard_vertical_always_applies() -> None:
    rule = _regex_rule(applies_to_vertical=["*"])
    ctx = _context(headline="badword", service_type="anything")
    result = evaluate(ctx, rules=[rule])
    assert _finding(result, "t.regex").verdict == "fail"


def test_missing_applies_to_vertical_defaults_to_all() -> None:
    rule = _regex_rule()
    del rule["applies_to_vertical"]
    ctx = _context(headline="badword", service_type="whatever")
    result = evaluate(ctx, rules=[rule])
    assert _finding(result, "t.regex").verdict == "fail"


def test_missing_service_type_treated_as_empty_vertical() -> None:
    rule = _regex_rule(applies_to_vertical=["*"])
    ctx = _context(headline="badword")
    ctx["client"] = {}
    result = evaluate(ctx, rules=[rule])
    assert _finding(result, "t.regex").verdict == "fail"


# ---------------------------------------------------------------------------
# do_not_say synthesis
# ---------------------------------------------------------------------------


def test_do_not_say_string_constraint_fires() -> None:
    ctx = _context(headline="we offer a free roof today", offer_constraints=["free roof"])
    result = evaluate(ctx, rules=[])
    f = _finding(result, "client.do_not_say.0")
    assert f.verdict == "fail"
    assert result.overall_verdict == "fail"


def test_do_not_say_is_whole_phrase_not_substring() -> None:
    # 'free roof' must not match inside 'freedom roofing'.
    ctx = _context(headline="freedom roofing co", offer_constraints=["free roof"])
    result = evaluate(ctx, rules=[])
    assert _finding(result, "client.do_not_say.0").verdict == "pass"


def test_do_not_say_dict_constraint_with_severity_warn() -> None:
    ctx = _context(
        body="we say risky thing",
        offer_constraints=[{"phrase": "risky thing", "reason": "legal", "severity": "warn"}],
    )
    result = evaluate(ctx, rules=[])
    f = _finding(result, "client.do_not_say.0")
    assert f.verdict == "fail"
    assert f.severity == "warn"
    # warn-severity fail is advisory -> overall does not hard-block.
    assert result.overall_verdict == "pass"


def test_do_not_say_dict_with_custom_required_edit() -> None:
    ctx = _context(
        headline="say the phrase",
        offer_constraints=[{"phrase": "the phrase", "required_edit": "use the approved wording"}],
    )
    result = evaluate(ctx, rules=[])
    assert _finding(result, "client.do_not_say.0").required_edit == "use the approved wording"


def test_do_not_say_invalid_severity_falls_back_to_block() -> None:
    ctx = _context(headline="say x", offer_constraints=[{"phrase": "say x", "severity": "nonsense"}])
    result = evaluate(ctx, rules=[])
    assert _finding(result, "client.do_not_say.0").severity == "block"


def test_synthesize_skips_empty_and_non_string_constraints() -> None:
    ctx = _context(offer_constraints=["", {"phrase": ""}, 12345, {"do_not_say": "alias works"}])
    synthesized = synthesize_do_not_say_rules(ctx)
    # Only the aliased dict constraint produces a rule. ``re.escape`` escapes
    # the space, so the pattern is ``\balias\ works\b``.
    assert len(synthesized) == 1
    assert "alias" in synthesized[0]["check_spec"]["patterns"][0]
    assert "works" in synthesized[0]["check_spec"]["patterns"][0]


def test_synthesize_with_no_client_returns_empty() -> None:
    assert synthesize_do_not_say_rules({"creative": {}}) == []


# ---------------------------------------------------------------------------
# rollup semantics
# ---------------------------------------------------------------------------


def test_rollup_block_fail_dominates() -> None:
    rules = [
        _regex_rule(rule_id="a", severity="warn"),
        _regex_rule(rule_id="b", severity="block"),
    ]
    ctx = _context(headline="badword")
    result = evaluate(ctx, rules=rules)
    assert result.overall_verdict == "fail"
    assert result.failed is True


def test_rollup_warn_fail_only_is_pass() -> None:
    rule = _regex_rule(severity="warn")
    ctx = _context(headline="badword")
    result = evaluate(ctx, rules=[rule])
    assert _finding(result, "t.regex").verdict == "fail"
    assert result.overall_verdict == "pass"


def test_rollup_needs_review_when_no_fail() -> None:
    ctx = _context()
    result = evaluate(ctx, llm_candidates=None, rules=[_llm_rule(engine="llm")])
    assert result.overall_verdict == "needs_review"
    assert result.needs_review is True


def test_rollup_fail_dominates_needs_review() -> None:
    rules = [_regex_rule(rule_id="det", severity="block"), _llm_rule()]
    ctx = _context(headline="badword")
    result = evaluate(ctx, llm_candidates=None, rules=rules)
    # det fails (block), llm escalates -> overall fail.
    assert result.overall_verdict == "fail"


def test_empty_ruleset_is_pass() -> None:
    result = evaluate(_context(), rules=[])
    assert result.overall_verdict == "pass"
    assert result.findings == []


# ---------------------------------------------------------------------------
# result serialization
# ---------------------------------------------------------------------------


def test_result_to_dict_round_trips_fields() -> None:
    ctx = _context(headline="badword")
    result = evaluate(ctx, rules=[_regex_rule()])
    d = result.to_dict()
    assert d["overall_verdict"] == "fail"
    finding = d["findings"][0]
    assert set(finding) == {
        "rule_id",
        "version",
        "severity",
        "verdict",
        "evidence",
        "required_edit",
        "citation_url",
    }
    assert finding["rule_id"] == "t.regex"
    assert finding["citation_url"] == "http://example.test/regex"


def test_finding_to_dict_standalone() -> None:
    f = Finding(
        rule_id="r",
        version="1",
        severity="block",
        verdict="fail",
        evidence="e",
        required_edit="fix",
        citation_url="http://x",
    )
    assert f.to_dict()["rule_id"] == "r"


# ---------------------------------------------------------------------------
# unknown spec type
# ---------------------------------------------------------------------------


def test_unknown_spec_type_has_no_deterministic_match() -> None:
    rule = _regex_rule(check_spec={"type": "mystery"})
    ctx = _context(headline="badword")
    result = evaluate(ctx, rules=[rule])
    assert _finding(result, "t.regex").verdict == "pass"


def test_default_starter_ruleset_used_when_rules_none() -> None:
    # Smoke: calling evaluate() without overriding rules pulls the seed set.
    ctx = _context(headline="Are you embarrassed by your bathroom?", service_type="remodeling")
    result = evaluate(ctx)
    assert any(f.rule_id == "meta.personal_attributes" for f in result.findings)
