---
name: ad-compliance
description: |
  Screen VoxHorizon ad creatives and copy against the Meta + FTC + per-client
  ruleset before launch. This is the operator's `compliance_review` HARD GATE
  skill: a vertical-aware policy check (Meta personal-attributes, before/after
  by vertical, FTC substantiation / guarantee-disclosure / unqualified
  superlative, Meta financial special-ad-category, Google overlay-text, and
  per-client do-not-say constraints), run two-pass (visual first, re-armed when
  copy changes). It produces CANDIDATE findings only; the worker adjudicates and
  writes the verdict, and only an audited manager override releases a failed
  unit. Trigger phrases: "run compliance", "screen this for Meta policy",
  "compliance check the copy", "is this ad compliant", "FTC substantiation
  check", "check personal attributes", "run the compliance gate".
---

# ad-compliance

This is the operator's **compliance_review** stage skill, and it is a **HARD
GATE**. It mirrors how Meta itself runs ad review: automation plus human. You
classify each creative/copy against a versioned ruleset and submit **candidate
findings**; the worker adjudicates the deterministic + LLM findings and writes
the verdict; a `failed` unit leaves `failed` only through an **audited manager
override** with a written justification.

Seeded from the VoxHorizon Ekko donor compliance guidance:

- `references/ad-copy-standards.md` — the house copy rules, with the Meta
  personal-attributes hook fixed on port. (Donor:
  `workspace/docs/ad-copy-standards.md`.)
- The vertical-aware policy notes carried in the Operator build-out scope
  (Meta personal-attributes, before/after by vertical, FTC, financial special
  ad category, Google overlay).

> **THE INVARIANT (the reason this stage exists).** You have **no tool that
> writes a compliance pass and no tool that clears a gate.** You submit
> candidates via `pipeline_operator_compliance_result`; the worker adjudicates.
> `uncertain` or low-confidence findings escalate to the manager, never an
> auto-pass. The advance route refuses to leave `compliance_review` while any
> creative is `failed` without an audited override. Compliance and launch never
> use the count-heuristic auto-advance.

---

## Two-pass model

Compliance runs twice per creative:

1. **Visual pass** (`pass_type: visual`) — before copy exists, screen the
   image: before/after legality for the vertical, on-image text, visible
   claims, anything visual that violates policy.
2. **Copy re-arm** (`pass_type: copy_rearm`) — after copy is authored/approved,
   the creative's compliance unit is **re-armed** (a prior pass is voided) and
   re-screened with the copy. Editing copy always re-arms compliance for that
   creative. This is why copy must be checked by compliance, and why an override
   is **void-on-content-change**.

---

## The ruleset (versioned, vertical-aware)

Rules are versioned data (lookup, not enum) because Meta/FTC policy churns. The
starter ruleset:

| `rule_id`                       | What it catches                                                                 | Applies                          |
| ------------------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| `meta.personal_attributes`      | Asserting/implying a personal attribute or self-perception ("Are you embarrassed by...", "Struggling with...", "Are you overweight"). | **All verticals** |
| `vertical.before_after`         | Before/after imagery/claims.                                                     | **Allowed** roofing/remodel; **banned** health/cosmetic/weight-loss |
| `ftc.substantiation`            | Claims needing proof (results, "guaranteed", "lifetime", "clinically proven").  | All; needs substantiation/disclosure |
| `ftc.guarantee_disclosure`      | Guarantee/warranty terms without the disclosure.                                | All                              |
| `ftc.unqualified_superlative`   | "Best", "#1", "cheapest" without basis.                                          | All                              |
| `meta.financial_special_ad`     | Financing offers (18+, no payday/<=90-day; Financial Special Ad Category since 2025-01-21). | Any financing offer  |
| `google.overlay_text`           | Overlay text on Google Display variants (overlay-free required).                | Google placements                |
| `client.do_not_say`             | The client's `offer_constraints` synthesized into do-not-say checks at eval time. | Per client                      |

**Personal attributes is the most common construction-niche trap.** The donor
`ad-copy-standards.md` previously recommended a violating remodeling hook ("Are
you embarrassed by your bathroom?"); the ported reference fixes it to a
benefit-framed alternative ("Ready for a bathroom you'll love?"). Always flag
self-perception framing, in any vertical, with the benefit-framed required edit.

---

## Procedure

1. Read the OUTSTANDING units (those not already
   `passed | overridden | skipped` for `compliance_review`) and the client
   `offer_constraints` (from `pipeline_operator_client_read`). Determine the
   `pass_type` (visual vs copy_rearm).
2. For each unit, classify against every applicable rule. The worker runs the
   deterministic backstops (regex/field-predicate, OCR text-area, resolution);
   you supply the `llm`/`both`-engine candidate labels.
3. For each finding, emit `{rule_id, version, label, confidence, evidence_span,
   required_edit, citation_url}`. `label` is `violation | clear | uncertain`
   per rule, never a creative-level "pass".
4. Submit the candidate array. The operator calls
   `pipeline_operator_compliance_result`; the worker adjudicates and writes the
   verdict. You do not call any write tool.

```json
{
  "candidates": [
    {
      "creative_id": "img-01",
      "pass_type": "copy_rearm",
      "findings": [
        {
          "rule_id": "meta.personal_attributes",
          "version": "2025.1",
          "label": "violation",
          "confidence": 0.92,
          "evidence_span": "Are you embarrassed by your bathroom?",
          "required_edit": "Reframe to a benefit: 'Ready for a bathroom you'll love?' Personal-attribute framing is a Meta violation.",
          "citation_url": "https://www.facebook.com/policies/ads/prohibited_content/personal_attributes"
        }
      ]
    }
  ]
}
```

---

## Hard-block + override discipline

- A `failed` unit holds the pipeline at `compliance_review`. It does **not**
  block its sibling creatives' work.
- Release requires **either** remediation (edit the copy/visual, which re-arms
  and re-runs the check) **or** an **audited manager override**: a manager-authed
  route, a required `override_note`, and the original `failed` finding retained
  append-only. Overrides are **void-on-content-change**.
- Never narrate a creative as "compliant". Narrate what you submitted and what
  the worker flagged, with the required edit.

---

## Self-check before you submit

1. Every OUTSTANDING unit classified against **every applicable rule** for the
   vertical?
2. The client `offer_constraints` checked as `client.do_not_say`?
3. Each `violation` carries a concrete `required_edit` and a frozen
   `citation_url`?
4. Genuine ambiguity / low confidence returned as `uncertain` (so the worker
   escalates), not forced to a verdict?
5. No creative-level "pass" emitted, and no gate cleared?

## Related

- `pipeline-operator` — drives this skill in the `compliance_review` HARD GATE;
  submits candidates via `pipeline_operator_compliance_result`.
- `templates/subagents/compliance.md` — the compliance specialist sub-agent
  contract.
- `copy-authoring` — copy is screened here; copy edits re-arm this gate.
- `campaign-launch` — the second HARD gate; launch needs compliance clear.
