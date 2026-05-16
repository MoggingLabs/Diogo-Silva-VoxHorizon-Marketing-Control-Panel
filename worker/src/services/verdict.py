"""Image-creative campaign verdict computation.

Given the latest performance pull for a single (client, campaign, window) row,
:func:`compute_verdict` returns the recommended action — ``"kill"``,
``"watch"``, or ``"keep"`` — plus a short human-readable reason.

The rules are intentionally simple and deterministic so the operator can verify
them by hand. Thresholds live as module-level constants so the Next.js side can
mirror them and so tests can introspect them.

Decision order (first match wins):

1. **Grace period** — anything launched < 48h ago is held at ``keep``.
2. **Kill rules** — strong evidence the creative is bleeding money.
3. **Watch rules** — concerning but not yet fatal.
4. **Keep** — within healthy thresholds.

The thresholds match the Wave 4 spec:

* Spend ≥ $75 with zero leads → kill
* CPL > 1.5× client target with zero leads → kill
* Frequency > 3 *and* CTR < 1% → kill (creative fatigue)
* CTR < 1% → watch
* Frequency > 3 → watch
* CTR > 2% → keep (strong)
* Else → keep (within thresholds)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


# ---------------------------------------------------------------------------
# Thresholds (mirrored on the Next.js side in `lib/audit.ts`)
# ---------------------------------------------------------------------------

#: Minimum days since launch before kill/watch rules apply.
GRACE_PERIOD_DAYS = 2

#: Hard kill threshold — spend with zero leads above this dollar amount.
KILL_SPEND_WITHOUT_LEADS = 75.0

#: Multiplier vs. ``clients.cpl_target`` that triggers a kill when leads = 0.
KILL_CPL_MULTIPLIER = 1.5

#: Frequency above which we flag a watch (or kill, combined with low CTR).
HIGH_FREQUENCY = 3.0

#: CTR below which we flag a watch.
LOW_CTR = 0.01  # 1%

#: CTR above which we flag a creative as strong.
STRONG_CTR = 0.02  # 2%


Verdict = Literal["kill", "watch", "keep"]


@dataclass(frozen=True)
class ImagePerfInput:
    """Inputs needed to compute a verdict for an image creative.

    Numeric values are kept as floats / ints so the caller can pass either the
    Supabase-returned ``numeric`` (already a float) or a freshly computed
    value. ``cpl_target`` is the per-client target from ``clients.cpl_target``
    and is optional — if absent we skip the CPL multiplier rule.
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


def _total_leads(p: ImagePerfInput) -> int:
    return (p.leads_meta or 0) + (p.leads_ghl or 0)


def compute_verdict(p: ImagePerfInput) -> tuple[Verdict, str]:
    """Return ``(verdict, reason)`` for an image campaign row.

    Rules are documented at the top of the module. The reason string is
    pre-formatted for direct display in the audit table tooltip.
    """
    leads = _total_leads(p)

    # 1. 48-hour grace period: never kill or warn on a brand-new ad.
    if p.days_since_launch < GRACE_PERIOD_DAYS:
        return "keep", f"{GRACE_PERIOD_DAYS * 24}h grace period"

    # 2. Kill rules ---------------------------------------------------------

    if (
        p.cpl_target is not None
        and p.cpl_real is not None
        and p.cpl_real > p.cpl_target * KILL_CPL_MULTIPLIER
        and leads == 0
    ):
        return (
            "kill",
            f"CPL ${p.cpl_real:.2f} > {KILL_CPL_MULTIPLIER:.1f}x target "
            f"(${p.cpl_target:.2f}) with zero leads",
        )

    if p.spend >= KILL_SPEND_WITHOUT_LEADS and leads == 0:
        return (
            "kill",
            f"${p.spend:.0f}+ spent with zero leads",
        )

    if p.freq > HIGH_FREQUENCY and p.ctr < LOW_CTR:
        return (
            "kill",
            f"creative fatigue: freq {p.freq:.1f}, CTR {p.ctr * 100:.2f}%",
        )

    # 3. Watch rules --------------------------------------------------------

    if p.ctr < LOW_CTR:
        return (
            "watch",
            f"low CTR {p.ctr * 100:.2f}% (< {LOW_CTR * 100:.0f}%)",
        )

    if p.freq > HIGH_FREQUENCY:
        return (
            "watch",
            f"high frequency {p.freq:.1f} (> {HIGH_FREQUENCY:.0f})",
        )

    # 4. Keep ---------------------------------------------------------------

    if p.ctr > STRONG_CTR:
        return (
            "keep",
            f"strong CTR {p.ctr * 100:.2f}% (> {STRONG_CTR * 100:.0f}%)",
        )

    return "keep", "within thresholds"
