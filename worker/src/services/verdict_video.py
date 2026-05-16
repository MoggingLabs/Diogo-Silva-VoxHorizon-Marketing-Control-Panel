"""Video-creative campaign verdict computation.

Video ads inherit every rule from :mod:`worker.src.services.verdict` and add
three engagement-specific signals on top:

* **Hook rate** — share of impressions that reach the 3-second mark. A weak
  hook with significant spend is a hard kill, since a video that can't earn
  the first 3 seconds will never convert at scale.
* **Drop-off at 3s** — share of viewers who dropped off after the hook. High
  drop-off paired with high spend escalates to a kill; otherwise watch.
* **Watch time (p50)** — median seconds watched. Below ~5s the video is
  effectively not being consumed, regardless of CTR.

The decision order remains "kill → watch → keep" with the same 48-hour grace
period. Video-specific rules are evaluated *after* the image rules already
fired, so a kill on spend+zero-leads still wins. The reason string is
pre-formatted for direct display.
"""

from __future__ import annotations

from dataclasses import dataclass

from .verdict import (
    GRACE_PERIOD_DAYS,
    HIGH_FREQUENCY,
    KILL_CPL_MULTIPLIER,
    KILL_SPEND_WITHOUT_LEADS,
    LOW_CTR,
    STRONG_CTR,
    ImagePerfInput,
    Verdict,
    compute_verdict as compute_image_verdict,
)


# ---------------------------------------------------------------------------
# Video-specific thresholds (mirrored on the Next.js side)
# ---------------------------------------------------------------------------

#: Hook-rate floor (3s viewers / impressions). Below this with high spend → kill.
LOW_HOOK_RATE = 0.20  # 20%

#: Spend above which a weak hook escalates from watch to kill.
HOOK_KILL_SPEND_FLOOR = KILL_SPEND_WITHOUT_LEADS  # $75 — matches image rule

#: Drop-off rate after 3s above which we flag.
HIGH_DROP_OFF_3S = 0.80  # 80%

#: Median watch time below which we flag as "very low watch time".
LOW_WATCH_TIME_P50_S = 5.0  # seconds


@dataclass(frozen=True)
class VideoPerfInput:
    """Inputs needed to compute a verdict for a video creative.

    Includes everything :class:`ImagePerfInput` does, plus four
    video-specific signals. ``hook_rate``, ``drop_off_3s``, ``view_rate_avg``
    are fractions in [0, 1]; ``watch_time_p50`` is in seconds.
    """

    spend: float
    impressions: int
    clicks: int
    ctr: float
    leads_meta: int
    leads_ghl: int
    cpl_real: float | None
    freq: float
    cpl_target: float | None
    days_since_launch: int
    hook_rate: float
    drop_off_3s: float
    view_rate_avg: float
    watch_time_p50: float


def _as_image_input(p: VideoPerfInput) -> ImagePerfInput:
    return ImagePerfInput(
        spend=p.spend,
        impressions=p.impressions,
        clicks=p.clicks,
        ctr=p.ctr,
        leads_meta=p.leads_meta,
        leads_ghl=p.leads_ghl,
        cpl_real=p.cpl_real,
        freq=p.freq,
        cpl_target=p.cpl_target,
        days_since_launch=p.days_since_launch,
    )


def compute_verdict(p: VideoPerfInput) -> tuple[Verdict, str]:
    """Return ``(verdict, reason)`` for a video campaign row.

    Order of evaluation:

    1. Grace period (handled by the image-rule pass first).
    2. If the image rule pass already returned ``kill``, propagate it — image
       kill rules (spend+no-leads, CPL multiplier, freq+CTR fatigue) are
       strictly stronger signals than the video-only ones.
    3. Video-specific kill: hook rate < 20% with spend ≥ $75.
    4. Video-specific watch: high drop-off, low watch-time, low hook.
    5. If still no video-specific signal fired, return whatever the image
       pass said (which will be ``"watch"`` or ``"keep"``).
    """
    # During grace period, defer to the image pass so the same "48h" reason
    # surfaces. Anything in grace stays at keep.
    if p.days_since_launch < GRACE_PERIOD_DAYS:
        return compute_image_verdict(_as_image_input(p))

    image_verdict, image_reason = compute_image_verdict(_as_image_input(p))

    # Image-side kills are strictly stronger; never downgrade.
    if image_verdict == "kill":
        return image_verdict, image_reason

    # 3. Video-specific kill: a weak hook with significant spend is fatal.
    if p.hook_rate < LOW_HOOK_RATE and p.spend >= HOOK_KILL_SPEND_FLOOR:
        return (
            "kill",
            f"hook rate {p.hook_rate * 100:.1f}% < {LOW_HOOK_RATE * 100:.0f}% "
            f"with ${p.spend:.0f} spend",
        )

    # 4. Video-specific watch rules. Pick the most severe applicable one.
    #    High drop-off + high spend escalates to kill.
    if p.drop_off_3s > HIGH_DROP_OFF_3S and p.spend >= HOOK_KILL_SPEND_FLOOR:
        return (
            "kill",
            f"drop-off {p.drop_off_3s * 100:.0f}% after 3s with ${p.spend:.0f} spend",
        )

    if p.drop_off_3s > HIGH_DROP_OFF_3S:
        return (
            "watch",
            f"high drop-off {p.drop_off_3s * 100:.0f}% after 3s",
        )

    if p.watch_time_p50 < LOW_WATCH_TIME_P50_S:
        return (
            "watch",
            f"very low watch time (p50 {p.watch_time_p50:.1f}s)",
        )

    if p.hook_rate < LOW_HOOK_RATE:
        return (
            "watch",
            f"low hook rate {p.hook_rate * 100:.1f}% (< {LOW_HOOK_RATE * 100:.0f}%)",
        )

    # 5. No video-specific signal fired → image-pass verdict wins.
    return image_verdict, image_reason


__all__ = [
    "VideoPerfInput",
    "compute_verdict",
    "LOW_HOOK_RATE",
    "HOOK_KILL_SPEND_FLOOR",
    "HIGH_DROP_OFF_3S",
    "LOW_WATCH_TIME_P50_S",
    # Re-export shared thresholds for convenience.
    "GRACE_PERIOD_DAYS",
    "HIGH_FREQUENCY",
    "KILL_CPL_MULTIPLIER",
    "KILL_SPEND_WITHOUT_LEADS",
    "LOW_CTR",
    "STRONG_CTR",
]
