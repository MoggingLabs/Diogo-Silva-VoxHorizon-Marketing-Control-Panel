---
name: copy-authoring
description: |
  Author launch-ready ad copy for VoxHorizon local-services creatives: >=3
  variants per creative (headline + primary text + description + CTA), in the
  owner's first-person voice, pattern-matched to the winning-copy registry,
  humanized to strip AI tells, and platform-validated for char limits. This is
  the craft skill the pipeline-operator's `copy` stage runs (in-context or via
  the copy specialist sub-agent) once a creative passes QA. It encodes the
  proven construction/roofing copy patterns, the homeowner-objection headline
  bar, the no-em-dash house rule, and the per-creative pairing discipline.
  Trigger phrases: "write the ad copy", "author copy for this creative",
  "3 headlines and primary text", "copy variants for the pipeline", "run the
  copy stage", "draft launch copy", "owner-voice roofing copy".
---

# copy-authoring

This is the operator's **copy** stage skill. Every creative that clears QA needs
copy before it can ship, and the copy carries the offer that actually sells. You
produce, per creative, **at least three variants** (headline + primary text +
description + CTA), in the client owner's voice, pattern-matched to what has
actually converted, humanized, and validated against the platform's limits.

Seeded from the VoxHorizon Ekko donor copy assets:

- `references/winning-copy-registry.md` — the proven hooks, patterns, and
  per-account top performers (Meta all-time data). **Read this before writing
  any copy.** (Donor: `workspace/knowledge/winning-copy-registry.md`.)
- `references/ad-copy-standards.md` — the house copy rules. (Donor:
  `workspace/docs/ad-copy-standards.md`, with the Meta personal-attributes hook
  fixed on port.)
- `references/roofing-ad-copy-patterns.md` and
  `references/mignogna-construction-copy-patterns.md` — the construction winner
  patterns Diogo likes. (Donor: `skills/copywriting/references/*`.)
- `references/humanizer.md` — the mandatory de-AI-slop pass. (Donor:
  `skills/creative/humanizer/SKILL.md`.)

---

## The one rule that beats every other rule

**The offer is the ad, and the copy is how the offer talks.** The winning copy
across every VoxHorizon account is first-person, owner-voiced, and built around
a concrete number. Generic benefit-speak loses. Before you write a line, read
`references/winning-copy-registry.md` and pattern-match against an ad that
actually converted. Do not generate copy from general knowledge when you have
data from ads that worked.

---

## Step 1 — Load the context (binding order)

1. `references/ad-copy-standards.md` — the house rules (binding).
2. `references/winning-copy-registry.md` — the proven patterns + per-account
   top performers.
3. The client profile (from `pipeline_operator_client_read`) — the client's
   active offers, owner name, proof points (years, reviews, rating, warranty),
   service area, voice/tone, and `offer_constraints` (hard do-not-say).
4. For roofing/remodeling: `references/roofing-ad-copy-patterns.md` and
   `references/mignogna-construction-copy-patterns.md`.
5. `references/humanizer.md` — apply it mentally as you write, then as an
   explicit final pass.

If the standards or the client `offer_constraints` are missing, stop. Do not
write copy without them.

---

## Step 2 — Pick the pattern per creative

Match the pattern to the visual and the angle the creative tests. The proven
patterns (ranked by portfolio performance):

| Pattern             | When it wins                                  | Pairs with                          |
| ------------------- | --------------------------------------------- | ----------------------------------- |
| **Price Shock**     | Best volume performer; price is the objection | Owner portrait, price-led visuals   |
| **Real Person Story** | Trust via a named customer                   | Testimonial / homeowner collage     |
| **Before & After**  | Visible transformation                        | Same-house before/after proof       |
| **Objection Crusher** | Cold audience, many objections              | FAQ-style or clean offer visuals    |
| **Anti-Corporate**  | Skeptical, been-burned homeowner              | Owner selfie                        |
| **Straight Offer**  | Warm audience / strong offer                  | Retargeting, offer-hero visuals     |

Pull the exact structure for each from `references/winning-copy-registry.md`.
The creative+copy pair is sacred: the copy must reference the specific visual,
never a generic "roofing image".

---

## Step 3 — Write the variants (>=3 per creative)

For each creative, produce at least three variants. For rush/launch shape,
default to one long, one medium, one medium-short primary text plus three
interchangeable headlines.

**Headline rules:**
- Under 40 characters where possible; the headline must work without the visual
  (mobile users scan it first).
- At least one headline per creative carries a **homeowner objection or felt
  problem**, not a generic offer label. Good: "Got a quote? Check it first.",
  "A new roof without the lump sum?", "Repair or replace? Know first." Avoid a
  set that is all "Free Roof Estimate" / "Roof Financing Available".
- Concrete offers (with a real number) are good as secondary headlines.

**Primary-text rules:**
- Hook in line 1, proof/specificity in lines 2-3, CTA direction in line 4.
- First person, owner voice ("I'm [Name], I run [Company]").
- Price Shock names the actual number. Social Proof names the actual count of
  jobs/years/customers. Before/After names the actual transformation.
- City name in the copy. Always localize to the client's real market.
- Short scan lines. No 4-line bricks. CTA on its own line. Vary the opener
  across variants so Ads Manager previews do not look cloned.

**CTA rules:**
- Specific and action-led: "Click 'Learn More' to schedule your FREE roof
  inspection", not "Contact us today".

---

## Step 4 — Humanize (mandatory pass)

Run every variant through `references/humanizer.md`. Strip AI tells: no em
dashes (the most common drift, including in headlines), no hype words
("amazing", "game-changing"), no stacked exclamation marks (one per ad max), no
significance inflation, no rule-of-three padding, no negative parallelism ("not
just X, it's Y"), no synonym cycling. The copy must read like a contractor
leveling with a homeowner, not a brand running a campaign.

Self-prompt after the draft: "What makes this read AI-generated?" Answer
honestly, then revise once more.

---

## Step 5 — Validate + structure for the operator

Validate each variant against the platform's char limits and house rules, then
hand the operator the structured array (the operator persists it via
`pipeline_operator_copy`; you do not call any write tool).

```json
{
  "creative_id": "img-01",
  "angle": "owner levels with the homeowner on roofing prices",
  "variants": [
    {
      "platform": "meta",
      "variant_index": 1,
      "pattern": "Price Shock",
      "headline": "Got a quote? Check it first.",
      "primary_text": "I know, $7,999 for a roof sounds crazy.\nRoofs are usually 15k, right?\nIt comes down to size, materials, and who you hire. I run a lean local crew, so you pay for the roof, not the billboards.\nClick Learn More for a straight-answer quote.",
      "description": "Fair price. Real crew. Straight answer.",
      "cta": "Learn More",
      "validation": { "headline_chars": 24, "primary_text_chars": 232, "no_em_dash": true, "humanized": true, "pattern_in_registry": true }
    }
  ]
}
```

---

## Self-check before you hand off

1. **>=3 variants** per creative, each tied to THIS visual (no copy reused
   across creatives)?
2. Every variant **pattern-tagged** to the winning registry (flag any invented
   pattern)?
3. At least one headline per creative is a **homeowner objection**, not a plain
   offer label?
4. **First person, owner voice**, real localized proof (no fabricated
   testimonials/pricing)?
5. **No em dashes** anywhere; no hype; short scan lines; CTA on its own line;
   varied openers?
6. **Humanizer pass** applied and the AI-tell self-check answered?
7. No `offer_constraints` (do-not-say) violated, and no personal-attribute
   framing (cross-check `ad-compliance`)?

If any is no, fix it before handing off. Copy edits **re-arm** the creative's
compliance unit — the operator runs the compliance re-arm pass after copy is
approved.

## Related

- `pipeline-operator` — drives this skill in the `copy` stage; persists via
  `pipeline_operator_copy`; approving copy re-arms compliance.
- `ad-compliance` — every draft is screened against the Meta/FTC ruleset.
- `templates/subagents/copy.md` — the copy specialist sub-agent contract.
- `image-ad-authoring` — the visual craft the copy is paired with.
