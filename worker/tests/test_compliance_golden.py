"""Golden-set compliance eval harness (P2.9 / #347).

Labeled fixtures gate every change to the compliance ruleset
(:mod:`services.compliance_rules`) or engine
(:mod:`services.compliance_engine`) in CI. Each ``golden/cases/*.json``
fixture pins an expected overall verdict (and optionally per-rule verdicts);
the harness runs it through :func:`evaluate` and asserts the expectation. A
rule edit that breaks a golden case fails CI.

The four acceptance-criteria cases (#347) are asserted by name so that
deleting a fixture is itself a CI failure:

  * the old "Are you embarrassed by your bathroom?" hook FAILS personal-attributes
  * the fixed benefit-framed hook PASSES
  * a guarantee claim without disclosure FAILS FTC
  * a roofing before/after PASSES (property, not health)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from src.services.compliance_engine import evaluate


_CASES_DIR = Path(__file__).parent / "golden" / "cases"


def _load_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for path in sorted(_CASES_DIR.glob("*.json")):
        with path.open(encoding="utf-8") as fh:
            case = json.load(fh)
        case["__file__"] = path.name
        cases.append(case)
    return cases


_ALL_CASES = _load_cases()


# The acceptance-criteria cases that MUST exist (#347). Removing any of these
# fixtures fails the suite, not just silently shrinks the golden set.
_REQUIRED_CASE_FILES = {
    "personal_attributes_old_hook.json",
    "personal_attributes_fixed_hook.json",
    "ftc_guarantee_no_disclosure.json",
    "roofing_before_after.json",
}


def test_golden_cases_are_discovered() -> None:
    assert _ALL_CASES, "no golden fixtures discovered under golden/cases/"


def test_required_acceptance_cases_present() -> None:
    found = {c["__file__"] for c in _ALL_CASES}
    missing = _REQUIRED_CASE_FILES - found
    assert not missing, f"missing required golden fixtures: {missing}"


@pytest.mark.parametrize("case", _ALL_CASES, ids=lambda c: c["__file__"])
def test_golden_case(case: dict[str, Any]) -> None:
    """Run one fixture through the engine and assert its recorded expectation."""
    context = case["context"]
    llm_candidates = case.get("llm_candidates")
    expect = case["expect"]

    result = evaluate(context, llm_candidates=llm_candidates)

    assert result.overall_verdict == expect["overall_verdict"], (
        f"{case['__file__']}: overall verdict "
        f"{result.overall_verdict!r} != {expect['overall_verdict']!r}; "
        f"findings={[f.to_dict() for f in result.findings]}"
    )

    rule_verdicts = expect.get("rule_verdicts", {})
    by_rule = {f.rule_id: f.verdict for f in result.findings}
    for rule_id, want in rule_verdicts.items():
        assert rule_id in by_rule, (
            f"{case['__file__']}: expected a finding for {rule_id!r}; "
            f"got {sorted(by_rule)}"
        )
        assert by_rule[rule_id] == want, (
            f"{case['__file__']}: rule {rule_id!r} verdict "
            f"{by_rule[rule_id]!r} != {want!r}"
        )


def test_old_hook_fails_personal_attributes_specifically() -> None:
    # The P0.5 invariant, asserted directly (not just via the table).
    case = _by_file("personal_attributes_old_hook.json")
    result = evaluate(case["context"], llm_candidates=case.get("llm_candidates"))
    pa = next(f for f in result.findings if f.rule_id == "meta.personal_attributes")
    assert pa.verdict == "fail"
    assert pa.severity == "block"
    assert result.overall_verdict == "fail"


def test_fixed_hook_passes() -> None:
    case = _by_file("personal_attributes_fixed_hook.json")
    result = evaluate(case["context"], llm_candidates=case.get("llm_candidates"))
    assert result.overall_verdict == "pass"


def test_guarantee_without_disclosure_fails_ftc() -> None:
    case = _by_file("ftc_guarantee_no_disclosure.json")
    result = evaluate(case["context"], llm_candidates=case.get("llm_candidates"))
    gd = next(f for f in result.findings if f.rule_id == "ftc.guarantee_disclosure")
    assert gd.verdict == "fail"
    assert result.overall_verdict == "fail"


def test_roofing_before_after_passes() -> None:
    case = _by_file("roofing_before_after.json")
    result = evaluate(case["context"], llm_candidates=case.get("llm_candidates"))
    # vertical.before_after must not even fire for roofing.
    assert all(f.rule_id != "vertical.before_after" for f in result.findings)
    assert result.overall_verdict == "pass"


def _by_file(name: str) -> dict[str, Any]:
    for case in _ALL_CASES:
        if case["__file__"] == name:
            return case
    raise AssertionError(f"golden fixture not found: {name}")
