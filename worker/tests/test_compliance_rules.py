"""Tests for the starter compliance ruleset (P2.8 / #346).

Asserts the seeded rules are well-formed and carry citations + versions, and
that the seed-count contract holds (the acceptance criterion).
"""

from __future__ import annotations

import re

import pytest

from src.services import compliance_rules as rules_mod
from src.services.compliance_rules import (
    RULESET_VERSION,
    get_rule,
    get_starter_rules,
    rule_count,
)


_REQUIRED_KEYS = {
    "rule_id",
    "version",
    "title",
    "applies_to_vertical",
    "surface",
    "severity",
    "engine",
    "check_spec",
    "required_edit",
    "citation_url",
}

_VALID_SURFACES = {"image", "copy", "targeting", "video"}
_VALID_SEVERITIES = {"info", "warn", "block"}
_VALID_ENGINES = {"deterministic", "llm", "both"}
_VALID_SPEC_TYPES = {"regex_any", "field_predicate", "llm_classify"}


def test_ruleset_version_is_a_string() -> None:
    assert isinstance(RULESET_VERSION, str)
    assert RULESET_VERSION


def test_rule_count_matches_seed() -> None:
    # The acceptance criterion (#346): a stable seed count. Seven copy/image
    # starter rules (personal_attributes, before_after, substantiation,
    # guarantee_disclosure, unqualified_superlative, financial_special_ad,
    # overlay_text) plus four video spoken-claim rules (VID-10:
    # spoken_personal_attributes, spoken_substantiation, spoken_superlative,
    # spoken_financial).
    assert rule_count() == 11
    assert len(get_starter_rules()) == rule_count()


def test_every_rule_has_the_required_keys() -> None:
    for rule in get_starter_rules():
        missing = _REQUIRED_KEYS - set(rule)
        assert not missing, f"{rule['rule_id']} missing {missing}"


def test_rule_ids_are_unique() -> None:
    ids = [r["rule_id"] for r in get_starter_rules()]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize("rule", get_starter_rules(), ids=lambda r: r["rule_id"])
def test_rule_fields_are_well_formed(rule: dict) -> None:
    assert rule["surface"] in _VALID_SURFACES
    assert rule["severity"] in _VALID_SEVERITIES
    assert rule["engine"] in _VALID_ENGINES
    assert isinstance(rule["applies_to_vertical"], list)
    assert rule["applies_to_vertical"]  # never empty
    assert rule["version"]
    assert rule["title"]
    assert rule["required_edit"]
    spec = rule["check_spec"]
    assert spec["type"] in _VALID_SPEC_TYPES


def test_non_client_rules_have_citations() -> None:
    # Every shipped rule freezes a citation URL on its findings.
    for rule in get_starter_rules():
        assert rule["citation_url"].startswith("http"), rule["rule_id"]


def test_regex_patterns_compile() -> None:
    for rule in get_starter_rules():
        spec = rule["check_spec"]
        if spec["type"] == "regex_any":
            for pattern in spec["patterns"]:
                re.compile(pattern)  # raises if malformed


def test_before_after_is_health_cosmetic_only() -> None:
    rule = get_rule("vertical.before_after")
    assert rule is not None
    applies = {v.lower() for v in rule["applies_to_vertical"]}
    # Banned for health/cosmetic...
    assert "health" in applies
    assert "cosmetic" in applies
    # ...and explicitly NOT applied to property verticals.
    assert "roofing" not in applies
    assert "remodeling" not in applies
    assert "*" not in applies


def test_personal_attributes_applies_to_all_verticals() -> None:
    rule = get_rule("meta.personal_attributes")
    assert rule is not None
    assert rule["applies_to_vertical"] == ["*"]
    assert rule["severity"] == "block"


def test_spoken_rules_mirror_their_copy_counterparts() -> None:
    # VID-10: the video voiceover-claim rules must detect the SAME claims as
    # their copy counterparts (a claim is the same violation whether spoken or
    # written) and scan the spoken surface, not the copy fields.
    pairs = [
        ("meta.personal_attributes", "meta.spoken_personal_attributes"),
        ("ftc.substantiation", "ftc.spoken_substantiation"),
        ("ftc.unqualified_superlative", "ftc.spoken_superlative"),
        ("meta.financial_special_ad", "meta.spoken_financial"),
    ]
    for copy_id, spoken_id in pairs:
        copy_rule = get_rule(copy_id)
        spoken_rule = get_rule(spoken_id)
        assert copy_rule is not None, copy_id
        assert spoken_rule is not None, spoken_id
        assert spoken_rule["surface"] == "video"
        assert spoken_rule["check_spec"]["fields"] == ["voiceover_text"]
        # Identical detection patterns: the two surfaces cannot drift.
        assert (
            spoken_rule["check_spec"]["patterns"]
            == copy_rule["check_spec"]["patterns"]
        )
        # Same severity + citation as the written counterpart.
        assert spoken_rule["severity"] == copy_rule["severity"]
        assert spoken_rule["citation_url"] == copy_rule["citation_url"]


def test_get_rule_unknown_returns_none() -> None:
    assert get_rule("does.not.exist") is None


def test_get_starter_rules_returns_independent_copies() -> None:
    # Mutating a returned rule must not corrupt the module source of truth.
    first = get_starter_rules()
    first[0]["applies_to_vertical"].append("MUTATED")
    first[0]["check_spec"].setdefault("patterns", []).append("MUTATED")
    second = get_starter_rules()
    assert "MUTATED" not in second[0]["applies_to_vertical"]
    assert "MUTATED" not in second[0]["check_spec"].get("patterns", [])


def test_copy_check_spec_copies_labels() -> None:
    # Cover the labels branch of the spec-copy helper (llm_classify specs).
    spec = {"type": "llm_classify", "labels": ["violation", "clear"]}
    copied = rules_mod._copy_check_spec(spec)
    copied["labels"].append("MUTATED")
    assert "MUTATED" not in spec["labels"]


def test_vertical_taxonomy_constants_present() -> None:
    assert "roofing" in rules_mod.PROPERTY_VERTICALS
    assert "weight_loss" in rules_mod.HEALTH_COSMETIC_VERTICALS
