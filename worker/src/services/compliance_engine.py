"""Compliance engine (P2.1 / #339).

A pure, importable JSON-rule DSL evaluator for the ``compliance_review``
HARD GATE (``PIPELINE-REBUILD-ARCHITECTURE.md`` Layer 3). It mirrors how
Meta itself runs ad review: deterministic automation + adjudicated
classification, with a worker-owned verdict that the operator can never
write directly.

What this module does
---------------------

* Runs the **deterministic** backstops itself (``regex_any`` /
  ``field_predicate`` ``check_spec`` types) over a creative/copy context.
* **Adjudicates** operator-supplied LLM *candidates* for ``llm`` / ``both``
  rules: a ``violation`` at or above the rule's ``min_confidence`` is a
  finding; ``uncertain`` or low-confidence candidates escalate to
  ``needs_review`` — they are **never** auto-passed.
* **Synthesizes** per-client ``client.do_not_say`` rules at eval time from
  ``context.client.offer_constraints`` so a client's "never say X" list is a
  first-class deterministic check.
* Returns structured findings + an overall verdict.

What this module does NOT do
----------------------------

No DB, no HTTP, no LLM calls. It is a function of its inputs. Persistence
(writing ``compliance_finding`` rows) and the HTTP endpoint that feeds it
``llm_candidates`` are wired in a later step; today the worker imports
:func:`evaluate` directly.

Verdict semantics
-----------------

* A finding's ``verdict`` is one of ``pass`` / ``fail`` / ``needs_review``.
* The **overall** verdict is ``fail`` if any *block*-severity finding failed;
  else ``needs_review`` if any finding needs review; else ``pass``. Non-block
  (``warn`` / ``info``) failures surface as findings but never hard-block the
  gate on their own — they are advisory. ``needs_review`` never silently
  passes (the escalation invariant).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal


Surface = Literal["image", "copy", "targeting"]
Severity = Literal["info", "warn", "block"]
Engine = Literal["deterministic", "llm", "both"]
Verdict = Literal["pass", "fail", "needs_review"]
CandidateLabel = Literal["violation", "clear", "uncertain"]


# Default LLM-candidate confidence floor when a rule's ``llm_classify``
# spec omits ``min_confidence``. Below this a ``violation`` candidate is not
# trusted enough to fail outright — it escalates to ``needs_review``.
DEFAULT_MIN_CONFIDENCE = 0.7


# ---------------------------------------------------------------------------
# Public result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Finding:
    """One adjudicated finding for one rule against the creative/copy.

    ``verdict`` is the per-rule outcome; the overall verdict is a roll-up of
    the findings (see :func:`evaluate`). ``evidence`` is the matched span /
    predicate detail / candidate evidence the finding rests on.
    """

    rule_id: str
    version: str
    severity: Severity
    verdict: Verdict
    evidence: str
    required_edit: str
    citation_url: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "version": self.version,
            "severity": self.severity,
            "verdict": self.verdict,
            "evidence": self.evidence,
            "required_edit": self.required_edit,
            "citation_url": self.citation_url,
        }


@dataclass(frozen=True)
class EvaluationResult:
    """The engine's full output: every finding + the roll-up verdict."""

    overall_verdict: Verdict
    findings: list[Finding] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "overall_verdict": self.overall_verdict,
            "findings": [f.to_dict() for f in self.findings],
        }

    @property
    def failed(self) -> bool:
        return self.overall_verdict == "fail"

    @property
    def needs_review(self) -> bool:
        return self.overall_verdict == "needs_review"


# ---------------------------------------------------------------------------
# Vertical matching
# ---------------------------------------------------------------------------


def _vertical_of(context: dict[str, Any]) -> str:
    """Lower-cased ``client.service_type`` (the creative's vertical)."""
    client = context.get("client") or {}
    service_type = client.get("service_type") or ""
    return str(service_type).strip().lower()


def _rule_applies_to_vertical(rule: dict[str, Any], vertical: str) -> bool:
    """Does ``rule`` apply to this vertical?

    ``['*']`` (or an empty/missing list) applies to all verticals. Otherwise
    the rule's ``applies_to_vertical`` is matched case-insensitively against
    the creative's vertical.
    """
    applies = rule.get("applies_to_vertical") or ["*"]
    if "*" in applies:
        return True
    norm = {str(v).strip().lower() for v in applies}
    return vertical in norm


# ---------------------------------------------------------------------------
# Field extraction
# ---------------------------------------------------------------------------


# Guarantee/warranty trigger terms for the FTC guarantee-disclosure rule.
_GUARANTEE_TERMS = re.compile(
    r"\b(guarantee[ds]?|guaranteed|warrant(?:y|ies)|warranties|lifetime)\b",
    re.IGNORECASE,
)
# A "disclosure" is satisfied when the copy spells out terms of the
# guarantee (duration / conditions / who honors it). We accept any of a few
# disclosure markers.
_GUARANTEE_DISCLOSURE = re.compile(
    r"\b(terms apply|see terms|conditions apply|"
    r"\d+[-\s]?(?:year|yr|day|month)s?\s+(?:warranty|guarantee)|"
    r"limited (?:warranty|guarantee)|"
    r"money[-\s]?back guarantee within)\b",
    re.IGNORECASE,
)


def _copy_text_fields(context: dict[str, Any]) -> dict[str, str]:
    """The copy fields the DSL reads, normalized to strings.

    ``context.copy`` may be ``None`` (visual pass, before copy exists) — then
    every field is the empty string, so copy-surface rules simply don't match.
    """
    copy = context.get("copy") or {}
    return {
        "headline": str(copy.get("headline") or ""),
        "body": str(copy.get("body") or ""),
        "description": str(copy.get("description") or ""),
        "cta": str(copy.get("cta") or ""),
    }


def _all_copy_text(context: dict[str, Any]) -> str:
    """Concatenation of the copy fields, for whole-copy predicates."""
    return " \n ".join(v for v in _copy_text_fields(context).values() if v)


def _resolve_field(context: dict[str, Any], fields: dict[str, str], name: str) -> Any:
    """Resolve a ``check_spec`` field name to a value.

    Copy fields (``headline`` / ``body`` / ``description`` / ``cta``) come
    from the copy block. A handful of *derived* predicates are computed here so
    a deterministic ``field_predicate`` rule can reason about them:

      * ``guarantee_terms_present``       — copy contains a guarantee/warranty term
      * ``guarantee_disclosure_present``  — copy contains the disclosure
      * ``has_overlay_text``             — creative has baked-in overlay text

    Anything else falls through to ``context.creative`` (so a rule can predicate
    on an arbitrary creative attribute).
    """
    if name in fields:
        return fields[name]
    if name == "guarantee_terms_present":
        return bool(_GUARANTEE_TERMS.search(_all_copy_text(context)))
    if name == "guarantee_disclosure_present":
        return bool(_GUARANTEE_DISCLOSURE.search(_all_copy_text(context)))
    if name == "has_overlay_text":
        creative = context.get("creative") or {}
        return bool(creative.get("has_overlay_text"))
    creative = context.get("creative") or {}
    return creative.get(name)


# ---------------------------------------------------------------------------
# Deterministic check_spec evaluators
# ---------------------------------------------------------------------------


def _eval_regex_any(
    rule: dict[str, Any], context: dict[str, Any]
) -> tuple[bool, str]:
    """``regex_any``: fire if ANY pattern matches ANY listed field.

    Returns ``(matched, evidence)`` where ``evidence`` is the matched span.
    """
    spec = rule["check_spec"]
    fields = _copy_text_fields(context)
    field_names: list[str] = spec.get("fields") or []
    patterns: list[str] = spec.get("patterns") or []
    for pattern in patterns:
        compiled = re.compile(pattern, re.IGNORECASE)
        for field_name in field_names:
            value = _resolve_field(context, fields, field_name)
            if value is None:
                continue
            match = compiled.search(str(value))
            if match:
                span = match.group(0).strip()
                return True, f"{field_name}: '{span}'"
    return False, ""


def _eval_field_predicate(
    rule: dict[str, Any], context: dict[str, Any]
) -> tuple[bool, str]:
    """``field_predicate``: fire when ``field == equals`` and a required field is absent.

    Two shapes:

      * ``then_require`` is ``None`` — fire whenever ``field == equals`` (the
        condition is itself the violation, e.g. overlay text present).
      * ``then_require`` is a field name — fire when ``field == equals`` but the
        required field is falsy (e.g. guarantee terms present but disclosure
        missing).
    """
    spec = rule["check_spec"]
    fields = _copy_text_fields(context)
    field_name = spec["field"]
    expected = spec.get("equals")
    actual = _resolve_field(context, fields, field_name)
    if actual != expected:
        return False, ""

    then_require = spec.get("then_require")
    if then_require is None:
        return True, f"{field_name} == {expected!r}"

    required_value = _resolve_field(context, fields, then_require)
    if required_value:
        return False, ""
    return True, f"{field_name} == {expected!r} but {then_require} is missing"


# ---------------------------------------------------------------------------
# LLM-candidate adjudication
# ---------------------------------------------------------------------------


def _index_candidates(
    llm_candidates: list[dict[str, Any]] | None,
) -> dict[str, list[dict[str, Any]]]:
    """Group operator-supplied candidates by ``rule_id``."""
    index: dict[str, list[dict[str, Any]]] = {}
    for cand in llm_candidates or []:
        rule_id = cand.get("rule_id")
        if not rule_id:
            continue
        index.setdefault(str(rule_id), []).append(cand)
    return index


def _min_confidence(rule: dict[str, Any]) -> float:
    """The rule's LLM confidence floor (``llm_classify.min_confidence``)."""
    spec = rule.get("check_spec") or {}
    if spec.get("type") == "llm_classify" and "min_confidence" in spec:
        return float(spec["min_confidence"])
    return DEFAULT_MIN_CONFIDENCE


def _adjudicate_candidates(
    rule: dict[str, Any], candidates: list[dict[str, Any]]
) -> tuple[Verdict, str] | None:
    """Adjudicate a rule's operator-supplied candidates into a verdict.

    The escalation invariant (NEVER auto-pass on uncertainty):

      * ``violation`` with ``confidence >= min_confidence``  -> ``fail``
      * ``violation`` with ``confidence <  min_confidence``  -> ``needs_review``
      * ``uncertain`` (any confidence)                       -> ``needs_review``
      * ``clear``                                            -> contributes a
        ``pass`` only if no other candidate escalates/fails

    Returns ``(verdict, evidence)`` or ``None`` when there are no candidates
    for this rule (the LLM dimension simply didn't run / had nothing to say —
    a ``both`` rule still has its deterministic side).
    """
    if not candidates:
        return None

    floor = _min_confidence(rule)
    verdict: Verdict = "pass"
    evidence = ""

    for cand in candidates:
        label = str(cand.get("label", "")).lower()
        confidence = _coerce_confidence(cand.get("confidence"))
        span = str(cand.get("evidence_span") or "").strip()

        if label == "violation":
            if confidence >= floor:
                # A confident violation is the strongest outcome — take it.
                return "fail", _candidate_evidence(span, confidence, "violation")
            # Under the floor: escalate, but a later confident violation can
            # still override to fail.
            if verdict != "fail":
                verdict = "needs_review"
                evidence = _candidate_evidence(span, confidence, "low-confidence violation")
        elif label == "uncertain":
            if verdict != "fail":
                verdict = "needs_review"
                evidence = _candidate_evidence(span, confidence, "uncertain")
        elif label == "clear":
            # 'clear' never downgrades an escalation; only stands if alone.
            if verdict == "pass" and not evidence:
                evidence = _candidate_evidence(span, confidence, "clear")
        else:
            # Unknown / malformed label is treated conservatively as uncertain.
            if verdict != "fail":
                verdict = "needs_review"
                evidence = _candidate_evidence(span, confidence, f"unknown label '{label}'")

    return verdict, evidence


def _coerce_confidence(value: Any) -> float:
    """Best-effort float in ``[0, 1]``; malformed -> ``0.0`` (conservative)."""
    try:
        conf = float(value)
    except (TypeError, ValueError):
        return 0.0
    if conf < 0.0:
        return 0.0
    if conf > 1.0:
        return 1.0
    return conf


def _candidate_evidence(span: str, confidence: float, kind: str) -> str:
    base = f"llm {kind} (confidence={confidence:.2f})"
    return f"{base}: '{span}'" if span else base


# ---------------------------------------------------------------------------
# Per-client do_not_say synthesis
# ---------------------------------------------------------------------------


def synthesize_do_not_say_rules(context: dict[str, Any]) -> list[dict[str, Any]]:
    """Build ``client.do_not_say`` rules from ``client.offer_constraints``.

    Each constraint becomes a deterministic ``regex_any`` rule that fires when
    the forbidden phrase appears in the copy. A constraint may be a plain
    string (the forbidden phrase) or a dict::

        {"phrase": "free roof", "reason": "...", "severity": "block",
         "required_edit": "..."}

    Constraints are matched as case-insensitive whole phrases (regex-escaped),
    so a constraint of ``"free roof"`` does not also match ``"freedom"``.
    """
    client = context.get("client") or {}
    constraints = client.get("offer_constraints") or []
    rules: list[dict[str, Any]] = []
    for index, constraint in enumerate(constraints):
        phrase, reason, severity, required_edit = _parse_constraint(constraint)
        if not phrase:
            continue
        rules.append(
            {
                "rule_id": f"client.do_not_say.{index}",
                "version": "client",
                "title": f"Client do-not-say: {phrase!r}",
                "applies_to_vertical": ["*"],
                "surface": "copy",
                "severity": severity,
                "engine": "deterministic",
                "check_spec": {
                    "type": "regex_any",
                    "fields": ["headline", "body", "description", "cta"],
                    "patterns": [rf"\b{re.escape(phrase)}\b"],
                },
                "required_edit": required_edit
                or (
                    f"This client's offer constraints forbid saying "
                    f"{phrase!r}. {reason}".strip()
                ),
                "citation_url": "",
            }
        )
    return rules


def _parse_constraint(
    constraint: Any,
) -> tuple[str, str, Severity, str]:
    """Normalize an offer-constraint into ``(phrase, reason, severity, edit)``."""
    if isinstance(constraint, str):
        return constraint.strip(), "", "block", ""
    if isinstance(constraint, dict):
        phrase = str(
            constraint.get("phrase") or constraint.get("do_not_say") or ""
        ).strip()
        reason = str(constraint.get("reason") or "").strip()
        severity = constraint.get("severity") or "block"
        if severity not in ("info", "warn", "block"):
            severity = "block"
        required_edit = str(constraint.get("required_edit") or "").strip()
        return phrase, reason, severity, required_edit  # type: ignore[return-value]
    return "", "", "block", ""


# ---------------------------------------------------------------------------
# The public entrypoint
# ---------------------------------------------------------------------------


def evaluate(
    context: dict[str, Any],
    llm_candidates: list[dict[str, Any]] | None = None,
    rules: list[dict[str, Any]] | None = None,
) -> EvaluationResult:
    """Evaluate a creative/copy ``context`` against the ruleset.

    Parameters
    ----------
    context:
        ``{creative: {...}, copy: {headline, body, description, cta} | None,
        client: {service_type, offer_constraints: [...]}, surface}``.
    llm_candidates:
        Operator-supplied candidate findings:
        ``[{rule_id, label, confidence, evidence_span}]``. Adjudicated for
        ``llm`` / ``both`` rules. ``None`` ⇒ no LLM dimension this pass.
    rules:
        Override the ruleset (tests / future per-pipeline rulesets). Defaults
        to the starter ruleset plus the synthesized per-client
        ``client.do_not_say`` rules.

    Returns
    -------
    :class:`EvaluationResult` with one :class:`Finding` per applicable rule
    that produced a non-pass outcome (plus passing findings so the audit trail
    shows every rule that ran), and the rolled-up ``overall_verdict``.
    """
    # Import here so the rules module stays an optional override and the
    # engine remains importable even if the seed module is refactored.
    from .compliance_rules import get_starter_rules

    base_rules = rules if rules is not None else get_starter_rules()
    all_rules = list(base_rules) + synthesize_do_not_say_rules(context)

    vertical = _vertical_of(context)
    candidate_index = _index_candidates(llm_candidates)

    findings: list[Finding] = []
    for rule in all_rules:
        if not _rule_applies_to_vertical(rule, vertical):
            continue
        finding = _evaluate_rule(rule, context, candidate_index)
        findings.append(finding)

    overall = _rollup(findings)
    return EvaluationResult(overall_verdict=overall, findings=findings)


def _evaluate_rule(
    rule: dict[str, Any],
    context: dict[str, Any],
    candidate_index: dict[str, list[dict[str, Any]]],
) -> Finding:
    """Adjudicate one rule into a single :class:`Finding`.

    Combines the deterministic check (if the rule has one) with the
    LLM-candidate adjudication (if the rule is ``llm`` / ``both``). The worst
    outcome wins: ``fail`` > ``needs_review`` > ``pass``.
    """
    engine = rule.get("engine", "deterministic")

    det_verdict: Verdict | None = None
    det_evidence = ""
    if engine in ("deterministic", "both"):
        matched, evidence = _run_deterministic(rule, context)
        det_verdict = "fail" if matched else "pass"
        det_evidence = evidence

    llm_result: tuple[Verdict, str] | None = None
    if engine in ("llm", "both"):
        llm_result = _adjudicate_candidates(
            rule, candidate_index.get(rule["rule_id"], [])
        )

    verdict, evidence = _combine_dimensions(
        engine, det_verdict, det_evidence, llm_result
    )

    return Finding(
        rule_id=rule["rule_id"],
        version=str(rule.get("version", "")),
        severity=rule.get("severity", "warn"),
        verdict=verdict,
        evidence=evidence,
        required_edit=rule.get("required_edit", ""),
        citation_url=rule.get("citation_url", ""),
    )


def _run_deterministic(
    rule: dict[str, Any], context: dict[str, Any]
) -> tuple[bool, str]:
    """Dispatch a rule's ``check_spec`` to its deterministic evaluator."""
    spec = rule.get("check_spec") or {}
    spec_type = spec.get("type")
    if spec_type == "regex_any":
        return _eval_regex_any(rule, context)
    if spec_type == "field_predicate":
        return _eval_field_predicate(rule, context)
    # ``llm_classify`` (and any unknown type) has no deterministic backstop —
    # it never matches on the deterministic side.
    return False, ""


# Verdict severity ordering for "worst outcome wins".
_VERDICT_RANK: dict[Verdict, int] = {"pass": 0, "needs_review": 1, "fail": 2}


def _combine_dimensions(
    engine: str,
    det_verdict: Verdict | None,
    det_evidence: str,
    llm_result: tuple[Verdict, str] | None,
) -> tuple[Verdict, str]:
    """Combine deterministic + LLM dimensions; the worst outcome wins.

    For a ``both`` rule with no candidates, the LLM dimension is *absent*
    (``None``) and the verdict rests on the deterministic side — but a ``both``
    rule whose deterministic side passes while the LLM side never ran does NOT
    escalate (the deterministic backstop is authoritative when the operator
    supplied no candidate).
    """
    options: list[tuple[Verdict, str]] = []
    if det_verdict is not None:
        options.append((det_verdict, det_evidence))
    if llm_result is not None:
        options.append(llm_result)

    if not options:
        # Pure-``llm`` rule with no candidate -> nothing classified yet. We do
        # NOT auto-pass an unscreened llm-only rule: escalate.
        return "needs_review", "llm rule with no candidate supplied"

    # Pick the worst (highest-ranked) verdict; keep its evidence.
    best = max(options, key=lambda opt: _VERDICT_RANK[opt[0]])
    return best


def _rollup(findings: list[Finding]) -> Verdict:
    """Roll findings up into the overall verdict.

    * ``fail`` if any **block**-severity finding failed.
    * else ``needs_review`` if any finding needs review.
    * else ``pass``.

    Non-block (``warn`` / ``info``) failures are advisory: they appear as
    findings but do not by themselves hard-block the gate.
    """
    has_block_fail = any(
        f.verdict == "fail" and f.severity == "block" for f in findings
    )
    if has_block_fail:
        return "fail"
    if any(f.verdict == "needs_review" for f in findings):
        return "needs_review"
    return "pass"
