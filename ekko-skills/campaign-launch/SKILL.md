---
name: campaign-launch
description: |
  Assemble, validate, and submit a VoxHorizon launch package PAUSED-first. This
  is the operator's `launch_handoff` HARD GATE skill: it enforces the
  preconditions checklist (spec-pass AND compliance-clear AND >=3 approved copy
  variants per creative), assembles the package (assets, per-ad copy,
  destination URL + plain-text UTMs, AI-enhancements OFF, the naming
  convention), and stages every Meta entity PAUSED via the operator Meta MCP as
  an orchestrated saga. Nothing goes live without an audited manager approval at
  the launch gate. Trigger phrases: "assemble the launch package", "validate
  the launch", "run the launch handoff", "stage the ads PAUSED", "is this ready
  to launch", "hand off to Meta", "launch gate".
---

# campaign-launch

This is the operator's **launch_handoff** stage skill, and it is the second
**HARD GATE**. You assemble and validate the launch package, then submit it
**PAUSED-first**. The irreversible Meta launch is an orchestrated saga
(create-campaign, then adset, then ad, each PAUSED with its own idempotency
key); compensation on failure is delete or leave-paused, never stop-live-spend.
Only the manager's audited approval at the launch gate activates anything.

Seeded from the VoxHorizon Ekko donor `launch-gate` skill:

- `references/meta-launch-safety.md` — the Graph API launch safety notes (hard
  approval rule, refresh defaults, AI/creative-enhancement opt-outs). (Donor:
  `skills/launch-gate/references/meta-launch-safety.md`.)
- The donor `launch-gate/SKILL.md` validation checklist, naming convention, and
  PAUSED-first discipline.

> **THE LAUNCH INVARIANT.** Never create anything `ACTIVE`. Never launch from
> casual wording ("do it", "take care of it"). `pipeline_operator_launch` only
> **submits** a PAUSED-first package; it requires approval (the Meta activate
> name is in `extra_requires_approval` and long-polls the dashboard). The
> manager's audited approval is the only thing that releases spend.

---

## Step 1 — Validate the preconditions (the gate predicate)

The launch gate will not open unless **every** picked, non-killed creative
satisfies all of these. Validate before assembling; if any fail, narrate the
gap and STOP (do not submit a package):

1. **Spec-pass** — every placement passed `spec_validation` (or has a surfaced,
   accepted exception).
2. **Compliance-clear** — every creative is `passed` or `overridden` in
   `compliance_review` (no `failed` unit). This is the hard block; an
   `overridden` unit must carry its audited `override_note`.
3. **Copy approved, >=3 variants per creative** — at least three approved copy
   variants per creative (tightened from the legacy >=1).
4. **Daily budget specified and > 0.**
5. **Targeting** radius/zips specified.
6. **Destination + landing page** specified.
7. **No placeholder text** (`NEEDS_INPUT`, `TBD`, `TODO`, "Image 1").
8. **Creative counts match** the brief/variant plan.

---

## Step 2 — Assemble the package

The package must include:

- **Campaign overview:** service, market, budget, offer, targeting,
  destination.
- **Exact assets** (the finalized Drive assets + their verified URLs from
  `finalize_assets`). Do not substitute a "closest" old asset; if a planned
  creative is missing, stop and flag it.
- **Per-ad copy:** primary text, headline, description, CTA (the approved
  variants).
- **Destination URL and URL tags / UTMs** as **plain-text raw strings** (never
  rich/clickable text from Docs).
- **AI / creative-enhancement settings: OFF** unless explicitly approved (use
  the `degrees_of_freedom_spec` opt-outs in `references/meta-launch-safety.md`).
- **The PAUSED-first plan** as an orchestrated saga (campaign, adset, ad), each
  with its own idempotency key.
- **An approval prompt** stating the next action is a PAUSED upload (not live
  activation).

### Naming convention

```text
[LAUNCH DATE] | [CREATIVE NAME] [CREATIVE VERSION] | [OFFER/ANGLE]
```

Example: `05.18 | Owner Selfie 1.0 | As Low As $99/mo`. Use clean new launch
names; do not append internal labels (`Copy Medium-Short`, creative IDs, API
markers) — they pollute later performance reads. Old ad names may appear only as
a clearly labeled "maps from old ad" note.

### Headline / angle packaging

Cover the funnel rather than repeating one trust claim: a TOF offer/price hook,
a MOF proof hook (years/reviews/owner), a BOF objection breaker (free
inspection, second opinion). If account history shows price/financing leads
outperform pure trust, make the price hook the lead headline.

---

## Step 3 — Submit (PAUSED-first, gated)

Submit the assembled package via `pipeline_operator_launch(pipeline_id,
package=...)`. This **requires approval**. On approval the operator Meta MCP
creates the entities PAUSED-first; the worker records the `ad_entity` graph
after the MCP calls. If the manager declines, narrate the decline and stop.

After staging, verify the Meta state by readback: status (PAUSED), destination
URL, URL tags, headline/copy preview, the creative image hash vs the intended
asset hash, and the creative-enhancement opt-outs. Report only review-ready
completion info (no API logs or raw secrets).

---

## Self-check before you submit

1. **All 8 preconditions pass** (especially compliance-clear and >=3 approved
   copy variants per creative)?
2. Package carries **exact** assets (verified Drive URLs), not "closest"
   substitutes?
3. UTMs are **plain-text** raw strings; AI-enhancements **OFF**?
4. Naming convention applied, no internal labels?
5. The plan is **PAUSED-first** with per-entity idempotency keys, and you are
   submitting (not activating)?

If any is no, fix it or STOP and flag the gap. Never create `ACTIVE`. The
manager's audited approval is the only release.

## Related

- `pipeline-operator` — drives this skill in the `launch_handoff` HARD GATE;
  submits via `pipeline_operator_launch` (approval-gated).
- `ad-compliance` — the first HARD gate; launch requires compliance clear.
- `copy-authoring` — launch requires >=3 approved copy variants per creative.
- `campaign-monitor` — runs after launch, on the live (then PAUSED-then-active)
  entities.
