"""Shared adjudication kernel for the Layer-3 gate engines (E3.4 #495).

The three gate engines -- :mod:`compliance_engine`, :mod:`qa_engine`, and
:mod:`video_probe` -- each grew a near-identical adjudication core: turn a
candidate (an LLM finding, a vision score, a probed fact) into a per-check
verdict, combine several dimensions into one verdict (worst outcome wins), and
roll a list of per-check verdicts up into one gate verdict. Each one also holds
the same hard invariant: **never auto-pass on uncertainty** -- a missing,
unmeasurable, or below-confidence signal escalates to ``needs_review`` rather
than silently passing.

This module extracts that core ONCE so the three engines consume it instead of
re-implementing it. It is deliberately tiny, pure, and free of any engine
vocabulary (no rules, no rubric, no ffprobe): it speaks only in the three
verdicts ``pass`` / ``fail`` / ``needs_review`` and the candidate signals the
engines feed it. The engines keep their own rules-as-versioned-data, their own
deterministic backstops, and their own result/finding dataclasses; only the
shared adjudication logic lives here.

What lives here
---------------

* :data:`VERDICT_RANK` -- the ``pass < needs_review < fail`` severity order.
* :func:`worst_outcome` -- "worst outcome wins" over a set of ``(verdict,
  evidence)`` options.
* :func:`rollup` -- roll per-check verdicts up to one gate verdict. The default
  is "any fail -> fail; else any needs_review -> needs_review; else pass"; an
  optional ``fail_when`` predicate lets a caller gate the ``fail`` rung on a
  per-finding condition (compliance fails only on *block*-severity findings).
* :func:`adjudicate_confidence` -- confidence-floor candidate adjudication: a
  ``violation`` at/above the floor fails; below the floor or ``uncertain`` or
  unknown escalates; ``clear`` stands only if nothing else escalates.
* :func:`adjudicate_score` -- score/threshold candidate adjudication: at/above
  the threshold passes; at/below the hard-fail floor fails; in between (or an
  unresolved score) escalates. Never auto-passes a missing/uncertain signal.
* :func:`clamp_unit` -- clamp a float into ``[0, 1]``.

The escalation invariant
-------------------------

Both adjudicators encode the same rule the architecture demands of every gate:
an uncertain signal is *not* a pass. :func:`adjudicate_confidence` escalates a
below-floor or uncertain or malformed candidate; :func:`adjudicate_score`
escalates an unresolved score or a mid-band score. The engines layer their own
"missing candidate -> needs_review" handling on top, so a check that was never
observed is escalated too.
"""

from __future__ import annotations

from typing import Any, Callable, Literal


Verdict = Literal["pass", "fail", "needs_review"]


# Verdict severity ordering for "worst outcome wins": a ``fail`` beats a
# ``needs_review`` beats a ``pass``. Shared by every engine's combine + rollup.
VERDICT_RANK: dict[Verdict, int] = {"pass": 0, "needs_review": 1, "fail": 2}


# ---------------------------------------------------------------------------
# Numeric helpers
# ---------------------------------------------------------------------------


def clamp_unit(value: float) -> float:
    """Clamp ``value`` into the closed unit interval ``[0.0, 1.0]``."""
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return value


# ---------------------------------------------------------------------------
# Worst-outcome combine
# ---------------------------------------------------------------------------


def worst_outcome(
    options: list[tuple[Verdict, str]],
    *,
    default: tuple[Verdict, str],
) -> tuple[Verdict, str]:
    """Pick the worst ``(verdict, evidence)`` option; keep its evidence.

    ``options`` is the set of dimensions that produced an outcome (e.g. a
    deterministic side and an LLM side). The highest-ranked verdict wins and
    carries its own evidence. When ``options`` is empty -- no dimension produced
    an outcome -- ``default`` is returned (the caller decides what an unscreened
    check means; the gate engines escalate rather than auto-pass).
    """
    if not options:
        return default
    return max(options, key=lambda opt: VERDICT_RANK[opt[0]])


# ---------------------------------------------------------------------------
# Rollup
# ---------------------------------------------------------------------------


def rollup(
    findings: list[Any],
    *,
    verdict_of: Callable[[Any], Verdict],
    fail_when: Callable[[Any], bool] | None = None,
) -> Verdict:
    """Roll per-finding verdicts up into one gate verdict.

    Semantics (the contract every gate engine shares):

      * ``fail`` if any finding failed -- gated, when ``fail_when`` is given, on
        that finding also satisfying ``fail_when`` (compliance fails only on a
        *block*-severity failure; a ``warn`` / ``info`` failure is advisory and
        surfaces as a finding without hard-blocking the gate).
      * else ``needs_review`` if any finding needs review.
      * else ``pass``.

    ``verdict_of`` extracts the :data:`Verdict` from a finding (a finding may be
    any per-check object the engine carries). ``fail_when`` defaults to "every
    failure blocks" when omitted (the qa / video engines have no severity gate).
    """
    has_block_fail = any(
        verdict_of(f) == "fail" and (fail_when is None or fail_when(f))
        for f in findings
    )
    if has_block_fail:
        return "fail"
    if any(verdict_of(f) == "needs_review" for f in findings):
        return "needs_review"
    return "pass"


# ---------------------------------------------------------------------------
# Confidence-floor candidate adjudication (compliance-style)
# ---------------------------------------------------------------------------


def adjudicate_confidence(
    candidates: list[dict[str, Any]],
    *,
    floor: float,
    evidence_of: Callable[[str, float, str], str],
) -> tuple[Verdict, str] | None:
    """Adjudicate confidence-labelled candidates into a verdict.

    The escalation invariant (NEVER auto-pass on uncertainty):

      * ``violation`` with ``confidence >= floor``  -> ``fail`` (the strongest
        outcome; returned immediately).
      * ``violation`` with ``confidence <  floor``  -> ``needs_review``.
      * ``uncertain`` (any confidence)              -> ``needs_review``.
      * unknown / malformed label                   -> ``needs_review``
        (treated conservatively as uncertain).
      * ``clear``                                   -> contributes a ``pass``
        only when nothing else escalated/failed.

    Each candidate is a ``{label, confidence, evidence_span}`` dict. ``floor`` is
    the rule's confidence floor. ``evidence_of(span, confidence, kind)`` formats
    the evidence string the caller wants on the finding. Returns
    ``(verdict, evidence)`` or ``None`` when there are no candidates at all (the
    LLM dimension simply did not run -- the caller's deterministic side stands).
    """
    if not candidates:
        return None

    verdict: Verdict = "pass"
    evidence = ""

    for cand in candidates:
        label = str(cand.get("label", "")).lower()
        confidence = _coerce_confidence(cand.get("confidence"))
        span = str(cand.get("evidence_span") or "").strip()

        if label == "violation":
            if confidence >= floor:
                # A confident violation is the strongest outcome -- take it.
                return "fail", evidence_of(span, confidence, "violation")
            # Under the floor: escalate, but a later confident violation can
            # still override to fail.
            if verdict != "fail":
                verdict = "needs_review"
                evidence = evidence_of(span, confidence, "low-confidence violation")
        elif label == "uncertain":
            if verdict != "fail":
                verdict = "needs_review"
                evidence = evidence_of(span, confidence, "uncertain")
        elif label == "clear":
            # 'clear' never downgrades an escalation; only stands if alone.
            if verdict == "pass" and not evidence:
                evidence = evidence_of(span, confidence, "clear")
        else:
            # Unknown / malformed label is treated conservatively as uncertain.
            if verdict != "fail":
                verdict = "needs_review"
                evidence = evidence_of(span, confidence, f"unknown label '{label}'")

    return verdict, evidence


def _coerce_confidence(value: Any) -> float:
    """Best-effort float in ``[0, 1]``; malformed -> ``0.0`` (conservative)."""
    try:
        conf = float(value)
    except (TypeError, ValueError):
        return 0.0
    return clamp_unit(conf)


# ---------------------------------------------------------------------------
# Score/threshold candidate adjudication (qa-style)
# ---------------------------------------------------------------------------


def adjudicate_score(
    score: float | None,
    *,
    threshold: float,
    hard_fail_floor: float,
) -> Verdict:
    """Adjudicate a resolved score against a threshold band into a verdict.

    Decision table (``t`` = ``threshold``, ``f`` = ``hard_fail_floor``):

      * ``score is None`` (uncertain / unresolved) -> ``needs_review``.
      * ``score >= t``                             -> ``pass``.
      * ``score <= f``                             -> ``fail``.
      * ``f < score < t``                          -> ``needs_review``.

    The worker is the adjudicator: a missing or uncertain score never
    auto-passes -- it escalates. Resolving a candidate to a score (parsing a
    label, normalising a 0..100 scale) is the caller's job; this function takes
    the resolved score and applies the band.
    """
    if score is None:
        return "needs_review"
    if score >= threshold:
        return "pass"
    if score <= hard_fail_floor:
        return "fail"
    return "needs_review"


__all__ = [
    "Verdict",
    "VERDICT_RANK",
    "clamp_unit",
    "worst_outcome",
    "rollup",
    "adjudicate_confidence",
    "adjudicate_score",
]
