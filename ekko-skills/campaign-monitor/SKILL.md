---
name: campaign-monitor
description: |
  Read live VoxHorizon ad performance against thresholds and call
  kill/watch/keep/scale, recommendations only. This is the operator's `monitor`
  stage skill: it computes Real CPL = Meta spend / GHL leads (GHL is the lead
  source of truth, never Meta), applies the decision thresholds (CTR,
  frequency, CPL, spend-without-leads), protects starved ads from a kill call,
  and feeds the winning angle into the next brief. It recommends; the manager
  approves kill/scale at the gate, and monitor never loops back, it seeds a new
  pipeline. Trigger phrases: "monitor the campaign", "run the monitor stage",
  "kill/watch/keep verdict", "which ads should I kill", "campaign health",
  "read the performance", "what's the real CPL".
---

# campaign-monitor

This is the operator's **monitor** stage skill. After launch, you read live
performance, reconcile leads against GHL, and call kill / watch / keep / scale
per ad. These are **recommendations only** — the manager approves kill/scale at
the gate, and the verdicts feed the **next** pipeline's brief (monitor does not
loop back; it seeds a new pipeline).

Seeded from the VoxHorizon Ekko donor monitoring assets:

- `references/decision-thresholds.md` — the binding kill/keep thresholds and the
  testing methodology. (Donor: `workspace/docs/decision-thresholds.md`.)
- The donor `campaign-audit` skill (GHL-as-lead-truth, active-hierarchy
  scoping, lead-dedup pitfalls, starved-ad protection).

> **GHL is the lead source of truth, never Meta.** Real CPL = Meta spend / GHL
> leads. Meta overcounts leads consistently (form submissions vs real people).
> Always pull GHL contacts for the same window and match them to ads. Report a
> Meta count only as unverified context if it differs.

---

## Scope first

- Evaluate only **ACTIVE ads inside ACTIVE adsets inside ACTIVE campaigns**.
  Paused/inactive entities are noise; do not put them in a verdict.
- Ad-level verdicts default to a **30-day** window (a 7-day pull hides spend
  that has been bleeding for weeks).
- Aggregate insight rows by `ad_id` before calling spend high or low (proxy
  pulls can return duplicate rows). Use only the `lead` action value, never the
  sum of `lead` + `fb_pixel_lead` + `onsite_web_lead` (that inflates leads
  3-4x).

---

## The thresholds (binding — `references/decision-thresholds.md`)

**Creative health:**
- CTR below 1%: underperforming, flag for review.
- CTR above 2%: strong, candidate to scale spend.
- Frequency above 3: creative fatigue likely, prepare replacements.
- CPL 2x above account average: kill, do not wait.
- $75 spend with zero leads: kill (ads that don't convert by $75 never do).

**Campaign health:**
- No leads in 48 hours: immediate alert.
- CPL trending up 3 consecutive days: flag and recommend action.

**Hold before a verdict:**
- Under 48 hours live: watch (the 48-hour rule), never kill.
- Under 1,000 impressions: insufficient data.
- Minimum 3-5 days or 1,000 impressions before declaring a winner.

**Starved-ad protection:** an ad with near-zero spend is `STARVED / UNPROVEN`,
not a loser. Do not recommend killing a starved ad just because it has 0 leads.
If a starved ad ever produced a cheap GHL lead, protect it from a kill call. The
real problem may be budget concentration into a slipping ad, not the starved
tests; recommend pausing the budget sink to force redistribution.

---

## Verdicts

| Verdict | Trigger                                                                                      |
| ------- | ------------------------------------------------------------------------------------------- |
| `kill`  | CPL 2x+ target after meaningful spend with near-zero GHL leads; OR $75 spend / 0 GHL leads; OR frequency >3 with collapsing GHL flow. |
| `watch` | Under 48h live; under 1,000 impressions; CPL above target but under 2x.                      |
| `keep`  | CPL at/under target with consistent GHL lead flow over 3+ days.                              |
| `scale` | CTR above 2% and CPL under target with headroom.                                            |

Each verdict needs **one specific, data-backed reason**. "Creative fatigue" is
banned unless you point to the CTR decay curve or the frequency number. No
vanity metrics (impressions/reach/CPM) as primary verdicts.

---

## Procedure

1. Walk the active hierarchy; pull Meta insights for the window.
2. Pull GHL contacts for the same window, match to ads (custom field containing
   "|" with the ad naming convention), count GHL leads.
3. Compute Real CPL per ad (Meta spend / GHL leads).
4. Apply the thresholds; protect starved ads.
5. Return the per-ad verdict array. The operator persists it via
   `pipeline_operator_monitor_result`; you do not call any write tool.

```json
{
  "results": [
    {
      "ad_entity_id": "ae-01",
      "ad_name": "05.18 | Owner Selfie 1.0 | As Low As $99/mo",
      "verdict": "keep",
      "spend": 312.40,
      "ghl_leads": 9,
      "real_cpl": 34.71,
      "ctr": 0.021,
      "frequency": 1.8,
      "reason": "CPL at target with steady GHL flow over 5 days; CTR 2.1%.",
      "next_move": "Hold; candidate to scale +$25/day if CPL holds 3 more days."
    }
  ]
}
```

---

## Feed the next brief

Roll the winners up by offer bucket (e.g. "As Low As $99/mo", "Starting at
$7,500", trust/local/reviews) and name the winning angle as the input to the
next pipeline's brief. Monitor closes the loop by spawning a new pipeline, not
by editing this one.

---

## Self-check before you hand off

1. Leads from **GHL**, deduped, with **Real CPL** computed (not Meta's count)?
2. Only **active-hierarchy** ads in the verdicts; rows aggregated by `ad_id`?
3. Starved ads labeled `STARVED / UNPROVEN`, not killed?
4. Each verdict has **one specific data-backed reason** (no vanity metrics, no
   bare "fatigue")?
5. A **next-brief angle** named from the winners?

These are recommendations; the manager approves kill/scale at the gate. Never
execute a Meta change from this stage.

## Related

- `pipeline-operator` — drives this skill in the `monitor` stage; persists via
  `pipeline_operator_monitor_result`.
- `templates/subagents/monitor.md` — the monitor specialist sub-agent contract.
- `campaign-launch` — the upstream gate that produced the live entities.
- `copy-authoring` — the next brief's copy patterns draw on the winners
  monitor surfaces.
