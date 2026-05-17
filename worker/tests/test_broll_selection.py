"""Tests for the broll selection-mode logic (V2-5).

Pure logic — no external services. Table-driven where possible so the
auto / review_each / review_low_confidence branches are exercised side
by side.
"""

from __future__ import annotations

import pytest

from src.services.broll_selection import (
    Candidate,
    LOW_CONFIDENCE_THRESHOLD,
    ScoredCandidate,
    Segment,
    SelectionResult,
    VALID_MODES,
    apply_selection_mode,
    score_candidate,
    score_segment,
)


# ---------------------------------------------------------------------------
# score_candidate / score_segment
# ---------------------------------------------------------------------------


def test_score_candidate_zero_when_segment_is_empty() -> None:
    seg = Segment(idx=0, theme="", query="", intent="")
    cand = Candidate(clip_id="c1", source_url="u", title="texas roof drone")
    assert score_candidate(seg, cand) == 0.0


def test_score_candidate_overlap_is_simple_fraction() -> None:
    """`|seg ∩ cand| / |seg|` — 3/3 tokens overlap = 1.0."""
    seg = Segment(idx=0, theme="texas roof drone", query="", intent="")
    cand = Candidate(clip_id="c1", source_url="u", title="drone shot texas roof")
    # All three signal tokens land — base 1.0, no theme equality bonus
    # because Candidate.theme is None.
    assert score_candidate(seg, cand) == pytest.approx(1.0)


def test_theme_equality_bonus_caps_at_one() -> None:
    seg = Segment(idx=0, theme="roof", query="", intent="")
    cand = Candidate(
        clip_id="c1",
        source_url="u",
        title="roof shot",
        theme="roof",
    )
    # base = 1.0 (token overlap "roof"); + 0.15 bonus capped to 1.0.
    assert score_candidate(seg, cand) == pytest.approx(1.0)


def test_score_candidate_no_signal_tokens_when_candidate_unrelated() -> None:
    seg = Segment(idx=0, theme="texas roof", query="", intent="")
    cand = Candidate(clip_id="c1", source_url="u", title="cooking soup recipe")
    assert score_candidate(seg, cand) == 0.0


def test_score_segment_is_deterministic_ties_break_lexicographically() -> None:
    """Two zero-score candidates sort by clip_id ascending."""
    seg = Segment(idx=0, theme="texas roof", query="", intent="")
    a = Candidate(clip_id="zzz", source_url="u")
    b = Candidate(clip_id="aaa", source_url="u")
    out = score_segment(seg, [a, b])
    assert [s.candidate.clip_id for s in out] == ["aaa", "zzz"]


def test_score_segment_orders_descending_by_score() -> None:
    seg = Segment(idx=0, theme="texas roof drone", query="", intent="")
    weak = Candidate(clip_id="weak", source_url="u", title="cooking")
    strong = Candidate(clip_id="strong", source_url="u", title="texas roof drone")
    out = score_segment(seg, [weak, strong])
    assert [s.candidate.clip_id for s in out] == ["strong", "weak"]
    assert out[0].score > out[1].score


# ---------------------------------------------------------------------------
# apply_selection_mode — auto
# ---------------------------------------------------------------------------


def _make_inputs() -> tuple[dict[int, list[Candidate]], dict[int, Segment]]:
    segments = {
        0: Segment(idx=0, theme="texas roof drone", query="texas roof shot"),
        1: Segment(idx=1, theme="water damage ceiling", query="leak"),
    }
    cands = {
        0: [
            Candidate(clip_id="seg0-weak", source_url="u1", title="random cooking"),
            Candidate(clip_id="seg0-strong", source_url="u2", title="texas roof drone shot"),
            Candidate(clip_id="seg0-mid", source_url="u3", title="roof"),
        ],
        1: [
            Candidate(clip_id="seg1-best", source_url="u4", title="water damage ceiling"),
            Candidate(clip_id="seg1-weak", source_url="u5", title="unrelated stuff"),
        ],
    }
    return cands, segments


def test_auto_picks_highest_scoring_clip_per_segment() -> None:
    cands, segments = _make_inputs()
    result = apply_selection_mode(mode="auto", candidates=cands, segments=segments)
    assert isinstance(result, SelectionResult)
    assert result.mode == "auto"
    assert result.needs_review == {}
    assert result.resolved[0].candidate.clip_id == "seg0-strong"
    assert result.resolved[1].candidate.clip_id == "seg1-best"
    assert result.confidence[0] > 0
    assert result.confidence[1] > 0


def test_auto_is_deterministic_across_runs() -> None:
    cands, segments = _make_inputs()
    a = apply_selection_mode(mode="auto", candidates=cands, segments=segments)
    b = apply_selection_mode(mode="auto", candidates=cands, segments=segments)
    assert a.to_dict() == b.to_dict()


def test_auto_with_empty_shortlist_leaves_segment_unresolved() -> None:
    segments = {0: Segment(idx=0, theme="x")}
    result = apply_selection_mode(
        mode="auto", candidates={0: []}, segments=segments
    )
    assert result.resolved == {}
    assert result.confidence[0] == 0.0
    # Auto mode should NOT escalate to review.
    assert result.needs_review == {}


# ---------------------------------------------------------------------------
# apply_selection_mode — review_each
# ---------------------------------------------------------------------------


def test_review_each_returns_full_shortlist() -> None:
    cands, segments = _make_inputs()
    result = apply_selection_mode(
        mode="review_each", candidates=cands, segments=segments
    )
    assert result.mode == "review_each"
    assert result.resolved == {}
    # Every segment is in needs_review.
    assert set(result.needs_review.keys()) == {0, 1}
    # Shortlists are sorted high → low and complete.
    assert len(result.needs_review[0]) == 3
    assert len(result.needs_review[1]) == 2
    # Confidence is the best score in each shortlist.
    assert result.confidence[0] == result.needs_review[0][0].score


def test_review_each_keeps_confidence_for_empty_shortlist() -> None:
    segments = {5: Segment(idx=5, theme="x")}
    result = apply_selection_mode(
        mode="review_each", candidates={5: []}, segments=segments
    )
    assert result.needs_review[5] == []
    assert result.confidence[5] == 0.0


# ---------------------------------------------------------------------------
# apply_selection_mode — review_low_confidence
# ---------------------------------------------------------------------------


def test_review_low_confidence_raises_by_default() -> None:
    cands, segments = _make_inputs()
    with pytest.raises(NotImplementedError) as exc:
        apply_selection_mode(
            mode="review_low_confidence",
            candidates=cands,
            segments=segments,
        )
    assert "review_low_confidence" in str(exc.value)


def test_review_low_confidence_resolves_high_confidence_segments() -> None:
    """With the flag set, segments above the threshold auto-resolve."""
    cands, segments = _make_inputs()
    result = apply_selection_mode(
        mode="review_low_confidence",
        candidates=cands,
        segments=segments,
        allow_review_low_confidence=True,
    )
    # Both seeded segments have a strong candidate that scores well above
    # 0.30 (the threshold), so both resolve.
    assert set(result.resolved.keys()) == {0, 1}
    assert result.needs_review == {}


def test_review_low_confidence_escalates_below_threshold() -> None:
    segments = {0: Segment(idx=0, theme="texas roof drone")}
    cands = {
        0: [
            Candidate(clip_id="weak", source_url="u", title="cooking random"),
        ]
    }
    result = apply_selection_mode(
        mode="review_low_confidence",
        candidates=cands,
        segments=segments,
        allow_review_low_confidence=True,
        low_confidence_threshold=0.5,
    )
    assert result.resolved == {}
    assert 0 in result.needs_review


# ---------------------------------------------------------------------------
# Misc: invalid mode + result serialisation
# ---------------------------------------------------------------------------


def test_unknown_mode_raises_value_error() -> None:
    with pytest.raises(ValueError) as exc:
        apply_selection_mode(
            mode="bogus",  # type: ignore[arg-type]
            candidates={},
            segments={},
        )
    assert "unknown selection mode" in str(exc.value)


def test_segment_in_candidates_without_segment_meta_raises() -> None:
    with pytest.raises(ValueError):
        apply_selection_mode(
            mode="auto",
            candidates={0: [Candidate(clip_id="c", source_url="u")]},
            segments={},  # missing idx=0
        )


def test_selection_result_to_dict_round_trip() -> None:
    cands, segments = _make_inputs()
    result = apply_selection_mode(mode="auto", candidates=cands, segments=segments)
    payload = result.to_dict()
    assert payload["mode"] == "auto"
    assert "0" in payload["resolved"]
    assert "0" in payload["confidence"]
    assert payload["needs_review"] == {}


def test_valid_modes_constant_and_threshold_are_exported() -> None:
    assert set(VALID_MODES) == {"auto", "review_each", "review_low_confidence"}
    assert 0 < LOW_CONFIDENCE_THRESHOLD < 1


def test_scored_candidate_to_dict_includes_score() -> None:
    sc = ScoredCandidate(
        candidate=Candidate(clip_id="x", source_url="u"), score=0.42
    )
    payload = sc.to_dict()
    assert payload["clip_id"] == "x"
    assert payload["score"] == 0.42
