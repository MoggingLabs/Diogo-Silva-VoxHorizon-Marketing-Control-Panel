"""Starter compliance ruleset (P2.8 / #346).

The concrete, versioned Meta + FTC + Google rules the
:mod:`services.compliance_engine` evaluates, authored in git so the
seeded ``compliance_rule`` lookup table is reviewable as data (the
architecture's "rules are versioned data, not enum" decision —
``PIPELINE-REBUILD-ARCHITECTURE.md`` Layer 3).

Each rule is a plain :class:`dict` matching the engine's rule contract::

    {
      "rule_id":            str,        # stable id, namespaced (meta.*, ftc.*, ...)
      "version":            str,        # bump when the check / citation changes
      "title":              str,
      "applies_to_vertical": list[str], # ['*'] = all verticals
      "surface":            str,        # 'image' | 'copy' | 'targeting'
      "severity":           str,        # 'info' | 'warn' | 'block'
      "engine":             str,        # 'deterministic' | 'llm' | 'both'
      "check_spec":         dict,       # one of: regex_any | field_predicate | llm_classify
      "required_edit":      str,        # the concrete remediation the operator gets
      "citation_url":       str,        # frozen policy citation (kept on the finding)
    }

Citations are sourced from ``OPERATOR-BUILDOUT.md`` §4 and the donor
``ekko-skills/ad-compliance`` ruleset. They are stored on every finding so
the audit trail is tamper-evident even if the upstream policy page moves.

These rules are **pure data** — no DB, no I/O. Persistence (seeding the
``compliance_rule`` table) is wired in a later step; the engine imports
:func:`get_starter_rules` directly today.
"""

from __future__ import annotations

from typing import Any


# ---------------------------------------------------------------------------
# Ruleset version
# ---------------------------------------------------------------------------

# The starter ruleset's coarse-grained version. Individual rules carry their
# own ``version`` (bumped per-rule when a check or citation changes); this
# constant is the snapshot tag the golden-set harness pins so a rule edit is
# a visible, reviewable diff.
RULESET_VERSION = "2025.1"


# ---------------------------------------------------------------------------
# Citations (frozen on findings)
# ---------------------------------------------------------------------------

_CITE_META_PERSONAL_ATTRIBUTES = (
    "https://www.facebook.com/policies/ads/prohibited_content/personal_attributes"
)
_CITE_META_BEFORE_AFTER = (
    "https://www.facebook.com/business/help/216456885667362"
)
_CITE_META_FINANCIAL_SAC = (
    "https://www.facebook.com/business/help/298000447747885"
)
_CITE_FTC_SUBSTANTIATION = (
    "https://www.ftc.gov/business-guidance/resources/advertising-faqs-guide-small-business"
)
_CITE_FTC_GUARANTEE = (
    "https://www.ftc.gov/legal-library/browse/rules/guides-against-deceptive-pricing"
)
_CITE_FTC_SUPERLATIVE = (
    "https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking"
)
_CITE_GOOGLE_OVERLAY = (
    "https://support.google.com/google-ads/answer/1722124"
)


# ---------------------------------------------------------------------------
# Vertical taxonomy
# ---------------------------------------------------------------------------

# Verticals whose before/after imagery + claims are *banned* (health,
# cosmetic, weight-loss). Property verticals (roofing, remodeling) keep
# before/after. The engine maps a free-text ``service_type`` onto these
# buckets; this list is the policy substance behind ``vertical.before_after``.
HEALTH_COSMETIC_VERTICALS = (
    "health",
    "cosmetic",
    "weight_loss",
    "weight-loss",
    "med_spa",
    "med-spa",
    "medspa",
    "dental",
    "aesthetics",
)

# Property / home-services verticals where before/after is allowed.
PROPERTY_VERTICALS = (
    "roofing",
    "remodeling",
    "remodel",
    "construction",
    "home_services",
    "home-services",
    "hvac",
    "landscaping",
)


# ---------------------------------------------------------------------------
# The starter rules
# ---------------------------------------------------------------------------

_STARTER_RULES: list[dict[str, Any]] = [
    # -- Meta: personal attributes (all verticals) -----------------------
    {
        "rule_id": "meta.personal_attributes",
        "version": "2025.1",
        "title": "Meta prohibits asserting or implying a personal attribute",
        "applies_to_vertical": ["*"],
        "surface": "copy",
        "severity": "block",
        "engine": "both",
        "check_spec": {
            "type": "regex_any",
            "fields": ["headline", "body", "description"],
            # Self-perception / personal-attribute framings. Word-boundaried,
            # case-insensitive (engine compiles with re.IGNORECASE).
            "patterns": [
                r"\bare you (embarrassed|ashamed|struggling|suffering|overweight|fat|balding|bald|insecure|self.?conscious)\b",
                r"\b(embarrassed|ashamed) (by|of|about) your\b",
                r"\bstruggling with your\b",
                r"\btired of being\b",
                r"\bdo you (suffer|struggle) (from|with)\b",
                r"\bare you (still )?(single|divorced|in debt|broke)\b",
            ],
        },
        "required_edit": (
            "Reframe to a benefit, not a personal attribute. "
            'e.g. "Ready for a bathroom you\'ll love?" instead of '
            '"Are you embarrassed by your bathroom?". Meta prohibits ads that '
            "assert or imply a personal attribute, including self-perception."
        ),
        "citation_url": _CITE_META_PERSONAL_ATTRIBUTES,
    },
    # -- Before / after, vertical-aware ----------------------------------
    {
        "rule_id": "vertical.before_after",
        "version": "2025.1",
        "title": "Before/after imagery is banned for health/cosmetic verticals",
        # Only health/cosmetic/weight-loss verticals — property verticals
        # (roofing/remodel) are intentionally NOT listed, so the engine never
        # fires this rule for them.
        "applies_to_vertical": list(HEALTH_COSMETIC_VERTICALS),
        "surface": "copy",
        "severity": "block",
        "engine": "both",
        "check_spec": {
            "type": "regex_any",
            "fields": ["headline", "body", "description"],
            "patterns": [
                r"\bbefore\s*(?:&|and|/|\+|->|→|vs\.?)\s*after\b",
                r"\bafter\s*(?:&|and|/|\+|->|→|vs\.?)\s*before\b",
                r"\bbefore[-\s]+and[-\s]+after\b",
            ],
        },
        "required_edit": (
            "Before/after imagery and claims are prohibited for "
            "health, cosmetic, and weight-loss verticals. Remove the "
            "before/after framing. (Allowed for roofing/remodeling/property.)"
        ),
        "citation_url": _CITE_META_BEFORE_AFTER,
    },
    # -- FTC: substantiation --------------------------------------------
    {
        "rule_id": "ftc.substantiation",
        "version": "2025.1",
        "title": "Objective claims need substantiation",
        "applies_to_vertical": ["*"],
        "surface": "copy",
        "severity": "warn",
        "engine": "both",
        "check_spec": {
            "type": "regex_any",
            "fields": ["headline", "body", "description"],
            "patterns": [
                r"\bclinically proven\b",
                r"\bscientifically proven\b",
                r"\bproven results\b",
                r"\bguaranteed results\b",
                r"\b100%\s+(?:effective|guaranteed|satisfaction)\b",
                r"\brisk[-\s]?free\b",
            ],
        },
        "required_edit": (
            "Claims like 'clinically proven' or 'guaranteed results' require "
            "competent and reliable substantiation on file. Either remove the "
            "claim or attach the supporting evidence/disclosure."
        ),
        "citation_url": _CITE_FTC_SUBSTANTIATION,
    },
    # -- FTC: guarantee / warranty needs disclosure ----------------------
    {
        "rule_id": "ftc.guarantee_disclosure",
        "version": "2025.1",
        "title": "Guarantee / warranty terms require a disclosure",
        "applies_to_vertical": ["*"],
        "surface": "copy",
        "severity": "block",
        "engine": "deterministic",
        "check_spec": {
            "type": "field_predicate",
            "field": "guarantee_terms_present",
            "equals": True,
            # When a guarantee/warranty term is present, the disclosure must
            # also be present. The engine derives ``guarantee_terms_present``
            # and ``guarantee_disclosure_present`` from the copy before
            # evaluating; the finding fires when terms exist but disclosure
            # does not.
            "then_require": "guarantee_disclosure_present",
        },
        "required_edit": (
            "A 'guarantee', 'warranty', or 'lifetime' claim must carry the "
            "material terms of the guarantee (duration, conditions, who "
            "honors it). Add the disclosure or drop the guarantee language."
        ),
        "citation_url": _CITE_FTC_GUARANTEE,
    },
    # -- FTC: unqualified superlative -----------------------------------
    {
        "rule_id": "ftc.unqualified_superlative",
        "version": "2025.1",
        "title": "Unqualified superlatives ('best', '#1', 'cheapest')",
        "applies_to_vertical": ["*"],
        "surface": "copy",
        "severity": "warn",
        "engine": "both",
        "check_spec": {
            "type": "regex_any",
            "fields": ["headline", "body", "description"],
            "patterns": [
                r"\b(?:the\s+)?best\b",
                r"#\s?1\b",
                r"\bnumber\s+one\b",
                r"\bcheapest\b",
                r"\blowest prices?\b",
                r"\bunbeatable\b",
                r"\bworld'?s\s+(?:best|finest|leading)\b",
            ],
        },
        "required_edit": (
            "Unqualified superlatives ('best', '#1', 'cheapest') imply an "
            "objective ranking claim. Qualify it ('one of the highest-rated "
            "in <city>'), cite the basis, or remove it."
        ),
        "citation_url": _CITE_FTC_SUPERLATIVE,
    },
    # -- Meta: financial special ad category -----------------------------
    {
        "rule_id": "meta.financial_special_ad",
        "version": "2025.1",
        "title": "Financing offers are a Financial Special Ad Category",
        "applies_to_vertical": ["*"],
        "surface": "copy",
        "severity": "block",
        "engine": "both",
        "check_spec": {
            "type": "regex_any",
            "fields": ["headline", "body", "description"],
            "patterns": [
                r"\$\d+\s*(?:/|per\s+)?\s*(?:mo|month)\b",
                r"\bno\s+(?:money\s+)?down\b",
                r"\bno\s+deposit\b",
                r"\bfinancing\s+available\b",
                r"\b0%\s+(?:apr|interest|financing)\b",
                r"\beasy\s+(?:monthly\s+)?payments?\b",
                r"\bpayday\s+loan\b",
            ],
        },
        "required_edit": (
            "Financing offers must run under Meta's Financial Products & "
            "Services Special Ad Category (effective 2025-01-21): 18+ only, "
            "no payday or sub-90-day loan terms, restricted targeting. Set the "
            "Special Ad Category on the campaign or remove the financing offer."
        ),
        "citation_url": _CITE_META_FINANCIAL_SAC,
    },
    # -- Google: overlay text on display variants ------------------------
    {
        "rule_id": "google.overlay_text",
        "version": "2025.1",
        "title": "Google Display variants must be overlay-text-free",
        "applies_to_vertical": ["*"],
        "surface": "image",
        "severity": "warn",
        "engine": "both",
        "check_spec": {
            "type": "field_predicate",
            "field": "has_overlay_text",
            "equals": True,
            # No additional requirement: presence of overlay text on a Google
            # placement is itself the violation.
            "then_require": None,
        },
        "required_edit": (
            "Google Display image ads should be overlay-text-free (text is "
            "added via the ad's text assets, not baked into the image). Supply "
            "a clean image variant for the Google placement."
        ),
        "citation_url": _CITE_GOOGLE_OVERLAY,
    },
]


def get_starter_rules() -> list[dict[str, Any]]:
    """Return a deep-ish copy of the starter ruleset.

    Returns a fresh list of fresh dicts so a caller mutating a rule (e.g. the
    engine appending a synthesized per-client rule) never corrupts the
    module-level source of truth.
    """
    rules: list[dict[str, Any]] = []
    for rule in _STARTER_RULES:
        copy = dict(rule)
        copy["applies_to_vertical"] = list(rule["applies_to_vertical"])
        copy["check_spec"] = _copy_check_spec(rule["check_spec"])
        rules.append(copy)
    return rules


def _copy_check_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """Shallow-copy a ``check_spec``, copying its list members too."""
    out = dict(spec)
    if isinstance(spec.get("fields"), list):
        out["fields"] = list(spec["fields"])
    if isinstance(spec.get("patterns"), list):
        out["patterns"] = list(spec["patterns"])
    if isinstance(spec.get("labels"), list):
        out["labels"] = list(spec["labels"])
    return out


def get_rule(rule_id: str) -> dict[str, Any] | None:
    """Return a single starter rule by ``rule_id`` (or ``None``)."""
    for rule in get_starter_rules():
        if rule["rule_id"] == rule_id:
            return rule
    return None


def rule_count() -> int:
    """Number of rules in the starter ruleset (seed-count assertion, #346)."""
    return len(_STARTER_RULES)
