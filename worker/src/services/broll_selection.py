"""B-roll selection mode logic (V2-5).

The operator picks a ``broll_selection_mode`` per video brief; this module
turns that mode + the raw candidate shortlist into either a resolved
``{segment_idx -> chosen_clip}`` mapping (the ``auto`` and high-confidence
``review_low_confidence`` paths) or a ``needs_review`` payload the UI
shows in the per-segment picker (V2-18 / ``review_each``).

Modes:

* ``auto`` — score each candidate against the segment's theme; return the
  highest-scoring clip per segment. Deterministic given the same inputs.
* ``review_each`` — pass the full shortlist through to the operator UI.
* ``review_low_confidence`` — auto-pick when confidence > threshold,
  otherwise route to the operator. **Deferred behind a flag in v1; raises
  NotImplementedError on selection.** Re-enable by setting
  ``allow_review_low_confidence=True`` in the call.

Scoring is intentionally simple in v1: token-overlap on the segment's
``broll_query`` / ``broll_intent`` / ``broll_theme`` against every text
field on the candidate (title, description, tags). No embeddings. This
keeps the math debuggable and fast enough to run per-request without a
model dependency. If the operator routinely complains about picks, the
next step is a cosine sim on theme embeddings — drop it in here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal


# Recognised modes — also the source of truth for the Next.js side, which
# duplicates this enum in TS. Keep them in lock-step.
SelectionMode = Literal["auto", "review_each", "review_low_confidence"]

VALID_MODES: tuple[SelectionMode, ...] = ("auto", "review_each", "review_low_confidence")


# Confidence threshold for ``review_low_confidence`` mode. Below this, the
# clip is too uncertain — escalate to the operator. The number is a tunable;
# we'll learn the right value once we have a few weeks of selection data.
LOW_CONFIDENCE_THRESHOLD = 0.30


# Stopwords + token splitter for the v1 keyword scorer. The split keeps
# digits (numeric stat hooks like "12 grand" matter for ad copy matching).
_STOPWORDS: frozenset[str] = frozenset(
    {
        "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
        "has", "have", "he", "in", "is", "it", "its", "of", "on", "or",
        "that", "the", "to", "was", "were", "will", "with",
        # Common b-roll fillers that don't add signal.
        "video", "clip", "shot", "footage", "scene", "shorts", "short",
    }
)

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(s: str) -> set[str]:
    """Lowercase + tokenize, drop stopwords."""
    return {t for t in _TOKEN_RE.findall(s.lower()) if t and t not in _STOPWORDS}


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Candidate:
    """A single b-roll candidate the selector scores.

    The fields mirror :class:`worker.src.services.broll_store.StoredClip`
    so the route layer can pass StoredClips directly via ``from_dict``.
    """

    clip_id: str
    source_url: str
    theme: str | None = None
    title: str | None = None
    description: str | None = None
    tags: tuple[str, ...] = ()
    duration_s: float | None = None
    dimensions: str | None = None

    def searchable_text(self) -> str:
        parts: list[str] = []
        for v in (self.theme, self.title, self.description, self.source_url):
            if isinstance(v, str) and v.strip():
                parts.append(v)
        parts.extend(t for t in self.tags if isinstance(t, str))
        return " ".join(parts)


@dataclass(frozen=True)
class Segment:
    """Segment inputs the selector needs to score against."""

    idx: int
    theme: str
    query: str = ""
    intent: str = ""

    def searchable_text(self) -> str:
        return " ".join(p for p in (self.theme, self.query, self.intent) if p)


@dataclass(frozen=True)
class ScoredCandidate:
    """``Candidate`` paired with its computed confidence in [0, 1]."""

    candidate: Candidate
    score: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "clip_id": self.candidate.clip_id,
            "source_url": self.candidate.source_url,
            "theme": self.candidate.theme,
            "score": round(self.score, 4),
        }


def score_candidate(segment: Segment, candidate: Candidate) -> float:
    """Token-overlap confidence in [0, 1].

    Jaccard-like: ``|seg ∩ cand| / |seg|`` (NOT divided by the union),
    because a candidate that covers all the segment's signal words at the
    cost of a million extra tokens should still score 1.0 — we don't
    penalise breadth.

    Theme equality is a strong signal — when the candidate's ``theme``
    matches the segment's theme exactly we add a small bonus on top.
    """
    seg_tokens = _tokenize(segment.searchable_text())
    if not seg_tokens:
        # No signal on the segment side — every candidate scores zero.
        return 0.0
    cand_tokens = _tokenize(candidate.searchable_text())
    overlap = len(seg_tokens & cand_tokens)
    base = overlap / len(seg_tokens)

    theme_bonus = 0.0
    if candidate.theme and candidate.theme.strip().lower() == segment.theme.strip().lower():
        theme_bonus = 0.15

    return min(1.0, base + theme_bonus)


def score_segment(
    segment: Segment, candidates: list[Candidate]
) -> list[ScoredCandidate]:
    """Score every candidate for one segment, sorted high → low.

    Ties break by the candidate's ``clip_id`` lexicographically so the
    output is deterministic across runs (the V2-5 acceptance criterion).
    """
    scored = [ScoredCandidate(c, score_candidate(segment, c)) for c in candidates]
    scored.sort(key=lambda sc: (-sc.score, sc.candidate.clip_id))
    return scored


# ---------------------------------------------------------------------------
# Mode application
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SelectionResult:
    """Output of :func:`apply_selection_mode`.

    Exactly one of ``resolved`` or ``needs_review`` is populated. The
    ``confidence`` map carries the winning score for every resolved
    segment so the route can persist it for audit.
    """

    mode: SelectionMode
    resolved: dict[int, ScoredCandidate] = field(default_factory=dict)
    needs_review: dict[int, list[ScoredCandidate]] = field(default_factory=dict)
    confidence: dict[int, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "resolved": {
                str(idx): sc.to_dict() for idx, sc in self.resolved.items()
            },
            "needs_review": {
                str(idx): [sc.to_dict() for sc in shortlist]
                for idx, shortlist in self.needs_review.items()
            },
            "confidence": {str(idx): round(c, 4) for idx, c in self.confidence.items()},
        }


def apply_selection_mode(
    *,
    mode: SelectionMode,
    candidates: dict[int, list[Candidate]],
    segments: dict[int, Segment],
    low_confidence_threshold: float = LOW_CONFIDENCE_THRESHOLD,
    allow_review_low_confidence: bool = False,
) -> SelectionResult:
    """Apply the operator-chosen selection mode to the candidate shortlist.

    Args:
      mode: The brief's ``broll_selection_mode``.
      candidates: ``{segment_idx -> [candidate, ...]}`` shortlist.
      segments: ``{segment_idx -> Segment}`` providing theme/query/intent.
      low_confidence_threshold: Below this, ``review_low_confidence`` mode
        escalates a segment to operator review.
      allow_review_low_confidence: Defaults to ``False`` per the V2-5 spec
        ("ships behind a flag in v2"). Setting to ``True`` runs the
        actual logic so we can unit-test the path.

    Raises:
      ValueError on unknown mode.
      NotImplementedError when ``mode == "review_low_confidence"`` and the
        flag is left at its default of ``False``.
    """
    if mode not in VALID_MODES:
        raise ValueError(f"unknown selection mode: {mode!r}")

    # Score every segment so downstream branches share the work.
    scored: dict[int, list[ScoredCandidate]] = {}
    for idx, cands in candidates.items():
        if idx not in segments:
            raise ValueError(
                f"segment idx={idx} has candidates but no Segment metadata"
            )
        scored[idx] = score_segment(segments[idx], cands)

    if mode == "review_each":
        # Return the full shortlist. Confidence map still includes the
        # best score so the UI can sort by it.
        confidence = {
            idx: (shortlist[0].score if shortlist else 0.0)
            for idx, shortlist in scored.items()
        }
        return SelectionResult(
            mode=mode,
            needs_review=scored,
            confidence=confidence,
        )

    if mode == "review_low_confidence":
        if not allow_review_low_confidence:
            raise NotImplementedError(
                "review_low_confidence ships behind a flag in v2 — pass "
                "allow_review_low_confidence=True to opt in."
            )
        resolved: dict[int, ScoredCandidate] = {}
        needs_review: dict[int, list[ScoredCandidate]] = {}
        confidence: dict[int, float] = {}
        for idx, shortlist in scored.items():
            if not shortlist:
                needs_review[idx] = []
                confidence[idx] = 0.0
                continue
            top = shortlist[0]
            confidence[idx] = top.score
            if top.score >= low_confidence_threshold:
                resolved[idx] = top
            else:
                needs_review[idx] = shortlist
        return SelectionResult(
            mode=mode,
            resolved=resolved,
            needs_review=needs_review,
            confidence=confidence,
        )

    # mode == "auto"
    resolved = {}
    confidence = {}
    for idx, shortlist in scored.items():
        if not shortlist:
            # No candidates at all → leave the segment unresolved but
            # don't escalate to review; auto mode shouldn't ever hand
            # back ``needs_review`` (the operator picked auto for a
            # reason). Confidence stays 0.
            confidence[idx] = 0.0
            continue
        top = shortlist[0]
        resolved[idx] = top
        confidence[idx] = top.score
    return SelectionResult(mode=mode, resolved=resolved, confidence=confidence)


__all__ = [
    "Candidate",
    "Segment",
    "ScoredCandidate",
    "SelectionResult",
    "SelectionMode",
    "VALID_MODES",
    "LOW_CONFIDENCE_THRESHOLD",
    "apply_selection_mode",
    "score_candidate",
    "score_segment",
]
