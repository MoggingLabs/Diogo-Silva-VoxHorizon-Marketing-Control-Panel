---
name: creative-qa
description: |
  Score VoxHorizon final ad renders for AI defects and brand consistency before
  they go to compliance and copy. This is the operator's `creative_qa` stage
  rubric: a per-defect-class vision check (hands, in-image text, anatomy,
  surface) plus a roofing detail sub-rubric and deterministic
  resolution/legibility/brand checks. Each creative gets a pass/fail verdict
  with specific defects and actionable re-render guidance; one failed creative
  routes to a targeted re-render and never blocks the others. Trigger phrases:
  "QA the renders", "run the creative QA stage", "check these images for AI
  defects", "roofing image detail check", "is this render shippable", "score
  the finals".
---

# creative-qa

This is the operator's **creative_qa** stage skill. After finals render, every
creative is vision-checked for the tell-tale AI failure modes and for whether it
looks like THIS client, before it spends a compliance or copy cycle. A roofing
image with mushy shingles is not project proof; it is AI filler. You score each
creative against a per-defect-class rubric and return a pass/fail verdict with
specific, actionable defects.

Seeded from the VoxHorizon Ekko donor image assets:

- `references/roofing-image-detail-qa.md` — the shingle-detail and before/after
  proof rules. (Donor: `skills/image-ad-prompting/references/roofing-image-detail-qa.md`.)
- The roofing-specific render rules in the donor `image-ad-prompting/SKILL.md`
  (structural plausibility, straight shingle lines, perspective).

This skill is the **standard**; the operator (or the qa specialist sub-agent)
applies it and the worker runs its own deterministic backstops (Pillow
resolution/legibility, OCR text-area) on top.

---

## Why this stage exists

A 16-billion-impression study finding underpins the whole pipeline: AI images
win **only if they don't look AI**. Contractor-iPhone realism beats glossy
slop. QA is the gate that catches the renders that betray the model before they
reach a paying launch. One bad render in a batch fails on its own row; it does
not drag down the creatives that passed.

---

## The rubric (per defect class)

Score each creative across these classes. **Any single `fail` makes the
creative `verdict: fail`.**

| Defect class      | Pass requires                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `hands`           | Correct finger count, natural pose; no warped/extra/fused fingers.                             |
| `in_image_text`   | No garbled/misspelled baked-in text; any offer stamp is <=6 words and legible (or absent).     |
| `anatomy`         | Faces, eyes, teeth, limbs all natural; no plastic/waxy skin, no uncanny stock-photo smile.     |
| `surface`         | The service surface is believable (see the roofing sub-rubric below).                          |
| `resolution`      | Sharp at the intended size; no smear/blur on the focal subject (worker backstop).              |
| `legibility`      | Reads as a ~400px thumbnail; the focal subject is clear (worker backstop).                     |
| `brand`           | Looks like THIS client (colors, market context), not generic stock.                            |

---

## Roofing detail sub-rubric (when `service_type == roofing`)

Roofing proof sells through detail. A usable roofing image shows:

- visible individual shingle rows
- dimensional asphalt texture / granule variation
- believable roof pitch and plane geometry
- clean flashing around chimney/dormers/valleys
- straight gutters, fascia, siding, and roof edges
- **no** melted, blurred, tiled, or overly smooth roof surface

**Before/after rules:** preserve house identity (dormer, chimney, siding, trim,
pitch, windows, camera angle); the "before" can be aged/stained but not
cartoonishly destroyed; the "after" must be clean and detailed, not
plastic-smooth. See `references/roofing-image-detail-qa.md` for the full
checklist and the prompt language that helped.

**QA method:** zoom/vision-check the roof surface itself, not just the overall
composition. Mushy or textureless shingles are a `surface` fail even if the
shot looks fine at a glance.

---

## Procedure

1. Identify the OUTSTANDING finals (those not already
   `passed | overridden | skipped` for `creative_qa`).
2. For each, score every defect class. For roofing, run the sub-rubric and zoom
   the surface.
3. Where a class fails, write a **specific** defect (the named flaw, not "looks
   AI") and a **remediation** note that is ready-to-use re-render prompt
   language (subject/setting fixes + the negatives to add).
4. Return the per-creative verdict array. The operator persists it via
   `pipeline_operator_qa_result` and the worker adds its deterministic checks;
   you do not call any write tool.

```json
{
  "results": [
    {
      "creative_id": "img-01",
      "verdict": "fail",
      "scores": { "hands": "pass", "in_image_text": "pass", "anatomy": "pass", "surface": "fail", "resolution": "pass", "legibility": "pass", "brand": "pass" },
      "defects": [
        "Shingle rows smear on the right roof plane; no granule texture.",
        "Roofline sags toward the dormer (warped perspective)."
      ],
      "remediation": "Re-render: visible individual shingle rows, realistic granule texture, straight rooflines, correct pitch. Add negatives: no melted shingle texture, no warped rooflines, no duplicate chimneys."
    }
  ]
}
```

---

## Self-check before you hand off

1. Every OUTSTANDING creative scored across **all** defect classes?
2. Roofing creatives run through the **surface sub-rubric** with a zoomed
   surface check?
3. Each `fail` has a **specific** named defect and **actionable** re-render
   language?
4. A `pass` only where **every** class passes (no softening a real defect to
   avoid a re-render)?

A failed creative routes to a targeted re-render; it never blocks the others.
The manager signs off QA at the gate.

## Related

- `pipeline-operator` — drives this skill in the `creative_qa` stage; persists
  via `pipeline_operator_qa_result`.
- `image-ad-authoring` — the visual craft and the negative-cue bank a re-render
  draws on.
- `templates/subagents/qa.md` — the qa specialist sub-agent contract.
- `ad-compliance` — the next per-creative gate after QA sign-off.
