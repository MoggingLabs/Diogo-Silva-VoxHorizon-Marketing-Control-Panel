---
name: image-ad-authoring
description: |
  Author high-converting local-services image ads end to end: a tight brief,
  N distinct concepts, and photoreal generation prompts that survive a paid
  render. Use this whenever you need to turn a market + offer into ad-ready
  image concepts (roofing, HVAC, plumbing, dental, med-spa, home services,
  legal, auto). It encodes the offer framing, angle selection, composition,
  lighting/lens craft, brand-safe on-image text rules, negative cues, and
  1:1-vs-9:16 intent that separate a scroll-stopping local ad from generic
  stock. Trigger phrases: "write an image-ad brief", "author ad concepts",
  "give me 4 ad concepts", "write a photoreal ad prompt", "concepts for a
  $99 inspection offer", "local services image ads".
---

# image-ad-authoring

This is the craft skill for **paid local-services image ads**. Every render
costs money, so the bar is: would a busy homeowner stop scrolling, believe
it, and act? You author three things, in order:

1. a **brief** — the strategy in one tight object,
2. **N distinct concepts** — each a different _reason to believe_,
3. a **photoreal generation prompt** per concept — built to survive the model.

`helper.py` documents the exact structure — the brief/concept fields, the
closed `ANGLES` vocabulary, the distinctness rule, and the baseline negative
cues. This file is the judgment.

> IMPORTANT — you have NO shell. Do NOT run `helper.py`, `python`, or any
> terminal/code tool (they are blocked). Author the brief and concept objects
> DIRECTLY as JSON, in the exact structures shown below, and pass them to the
> `pipeline_operator_brief` / `pipeline_operator_render` MCP tools. The code
> blocks below are the shape to PRODUCE, not code to run — the worker validates
> every payload server-side, so nothing malformed reaches a paid render.

---

## The one rule that beats every other rule

**The offer is the ad.** In local lead-gen, the creative's job is to make a
_specific, concrete, low-friction offer_ impossible to ignore. A beautiful
photo with a vague offer loses to a plain photo with "$99 roof inspection."
Lead with the offer in your thinking, then dress it.

A strong offer is: **specific number + specific service + low commitment.**

- Strong: "$99 roof inspection", "Free 21-point AC tune-up", "$0 down, $89/mo"
- Weak: "Quality roofing", "Best prices in town", "Call us today"

If the offer you were handed is weak, say so in your narration and propose a
sharper one — do not silently render a weak offer.

---

## Step 1 — The brief (strategy in one object)

Build it with `build_image_brief(...)`. Required: `market`, `offer_text`,
`angles`. Optional but valuable: `service_type`, `audience`, `extras`
(budget, brand colors, claims you must NOT make).

```python
from helper import build_image_brief

payload = build_image_brief(
    market="Austin TX roofing",
    offer_text="$99 roof inspection",
    angles=["before_after", "owner_led_trust", "savings", "urgency"],
    service_type="roofing",
    audience="homeowners 35-65, post-storm, value trust over lowest price",
    extras={"budget_per_day": 50, "must_avoid": ["guaranteed approval"]},
)
```

Think about three things while you fill it:

- **Market** = geography _and_ service, because both change the imagery
  (Phoenix roof != Seattle roof; a med-spa != a plumber). Be concrete.
- **Audience** = who clicks and _why they hesitate_. The hesitation is your
  angle fuel: "afraid of a surprise bill" → savings/transparency; "afraid of
  a fly-by-night crew" → owner-led trust / authority.
- **Offer** = the hook, in the customer's words. This becomes the optional
  short on-image stamp and the platform caption's headline.

The `angles` list is also your **concept plan**: one angle → one concept.
Order it by what you'd bet on first.

### When client context is present

The `pipeline-operator` skill may hand you a **client context** (from
`pipeline_operator_client_read`: brand, profile, offers, constraints, value
props). When it does, author from it instead of generic assumptions:

- **`offer_text`** comes from the client's active `offers` — use a real offer
  the client runs, not an invented one. (If every offer is weak, flag it and
  propose sharpening _within_ what the client actually sells.)
- **`must_avoid` / `extra_negatives`** must include the client's
  `offer_constraints` — these are do-not-say compliance rules; never write copy,
  on-image text, or angles that violate them.
- **Voice and setting** reflect the client's `tone` / `voice_note` and local
  market (`city` / `state` / `primary_city`, `targeting_detail`) — the mood,
  wording, and the house style of the shot should sound and look like _this_
  client in _their_ service area, not stock.
- **Targeted area** — when the client context carries a structured `targeting`
  block (`{address, zip, radius_miles, type, description}`), let the ad's
  `setting`/locale reflect the targeted area: anchor the shot to the
  address/zip city, and let `radius_miles` set how broad the geo framing
  should feel. A tight radius (e.g. ~10-25 mi) reads like one neighborhood —
  a specific local street, a recognizable nearby home style; a wide radius
  (e.g. 150 mi) covers a whole metro/region, so keep the setting
  regionally typical rather than hyper-local. When `radius_miles` is null
  (a gap), don't invent a distance — fall back to the `description` prose and
  the city/state cues. This is judgment you bake into the `setting` text you
  author directly; there is nothing to run.
- **Proof points** back the `social_proof` and `authority` angles: pull
  `years_in_business`, google reviews / rating, `warranty`, licensed/insured,
  family-owned, project counts from the profile — but only claim proof that is
  actually present.

---

## Step 2 — Choose distinct angles (different reasons to believe)

An "angle" is the psychological reason the ad works. Distinct concepts must
use _distinct angles_ — four variations of the same idea is one test, not
four. The helper enforces this (`assert_distinct_concepts`); use the closed
vocabulary in `helper.ANGLES`:

| Angle slug          | When it wins                                                        | Visual signature                                                                   |
| ------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `before_after`      | The result is visually obvious (roofs, lawns, teeth, detailing)     | Split or single "after" hero, the transformation is the subject                    |
| `owner_led_trust`   | Trust is the barrier; commodity service; "who will show up?"        | A real owner/operator on-site, branded shirt, eye contact, handshake               |
| `social_proof`      | Crowded market; "everyone near me uses them"                        | Multiple happy customers, a row of yard signs, a 5-star motif done tastefully      |
| `urgency`           | Seasonal/weather/slot-limited; procrastination is the enemy         | Storm sky, falling leaves, "booking fast" energy — _implied_, not a fake countdown |
| `savings`           | Price-sensitive buyer; the math is the hook                         | The offer as hero; clean, value-forward, the number front and center               |
| `problem_agitation` | The cost of _not_ acting is concrete (leak, mold, breakdown)        | The problem mid-consequence — water stain, cracked unit — tasteful, not gross      |
| `authority`         | High-stakes/regulated; license/guarantee matters (HVAC, electrical) | Certifications, clean uniformed pro, guarantee badge feel                          |

**Default 4-concept plan for most home services:** `before_after`,
`owner_led_trust`, `savings`, `urgency`. It covers result, trust, price, and
timing — the four objections in one test. Swap in `authority` or
`problem_agitation` when the service is high-stakes or the pain is visceral.

Each concept should be winnable on its own merits — assume the manager picks
exactly one to scale.

---

## Step 3 — Compose the shot (make it stop the scroll AND look real)

Build each concept with `build_concept(...)`. You supply six craft fields;
the helper orders them (subject and setting first — models weight early
tokens), appends the framing for the ratio, and bolts on negative cues.

```python
from helper import build_concept

concept = build_concept(
    angle="owner_led_trust",
    concept_label="handshake on finished roof",
    subject=("a friendly roofer in his 40s wearing a clean branded navy polo, "
             "shaking hands with a relieved female homeowner, both smiling "
             "naturally, standing on a freshly shingled roof"),
    setting=("a well-kept two-story suburban Austin home, new charcoal "
             "architectural shingles, green lawn, blue sky with light clouds"),
    lighting="warm golden-hour side light, soft natural shadows, gentle rim light",
    lens="35mm, f/2.8, subtle depth of field, slight background blur",
    mood="trustworthy, relieved, premium but approachable",
    ratio="1x1",
    offer_text="$99 roof inspection",
    extra_negatives=["no ladder in frame", "no roofing debris", "no harsh midday glare"],
)
```

### The craft fields, and why each matters

- **subject** — the hero. Make it **concrete and human** wherever possible.
  People > products > abstractions for trust and stop-rate. Specify age,
  wardrobe (branded shirt = instant credibility), action (handshake, holding
  the result), and genuine expression. "A roofer" is weak; the example above
  is castable.
- **setting** — real and _local_. Specific house style, specific materials,
  specific region cues. Generic settings read as stock and get scrolled.
- **lighting** — the single biggest realism lever. Name a real lighting
  condition: "golden-hour side light", "soft overcast diffusion", "bright
  clean daylight, no harsh shadows". Avoid "studio lighting" for on-location
  services; it screams ad.
- **lens** — borrow a photographer's vocabulary so the model renders _a
  photo_, not an illustration. "35mm, f/2.8, slight depth of field" for
  people; "24mm" for wide context; "85mm, f/1.8" for a tight portrait of the
  owner. Shallow depth of field separates subject from background and reads
  as premium.
- **mood** — the feeling the buyer leaves with. Tie it to the angle: trust →
  "trustworthy, relieved"; savings → "smart, satisfied"; urgency →
  "decisive, in-control".
- **ratio** — see Step 5. The helper injects the right framing guidance, but
  you should pick the subject placement with the crop in mind.

### Composition heuristics

- **One focal subject.** Feed thumbnails are tiny; a single clear hero beats
  a busy scene every time.
- **Rule of thirds or centered** for the hero; leave the **lower third**
  cleaner for the offer stamp and so the platform's UI doesn't cover the
  point.
- **Real faces, real eye contact** drive trust and stop-rate. Use them in
  `owner_led_trust`, `social_proof`, `authority`.
- **Show the result, not the process** for `before_after` and `savings`
  unless the process _is_ the proof (e.g. a clean, organized work area).
- **Branded wardrobe** (polo, truck, simple cap) is the cheapest credibility
  signal you can add — include it in any trust/authority concept.

---

## Step 4 — On-image text and negative cues (don't let the model betray you)

**On-image text:** image models reliably render only _short_ text. Keep any
baked-in text to a **6-word-or-fewer offer stamp** (`validate_onimage_text`
enforces this) and put real copy in the platform caption, where it stays
crisp and editable. For clean _concept previews_, prefer **no on-image text
at all** — let the picture earn the click and let the caption carry the
offer. Add the stamp on the **final** render once a concept is chosen, if at
all. Never ask the model to paint a paragraph, a phone number, or a logo —
it will mangle them.

**Negative cues:** every prompt the helper builds already carries a baseline
that suppresses the tell-tale AI failure modes (`helper.BASELINE_NEGATIVE_CUES`):
garbled text, warped/extra fingers, distorted faces, plastic skin, extra
limbs, watermark artifacts, lens distortion on straight edges, uncanny
stock-photo smiles, illegible signage. **Add concept-specific negatives** via
`extra_negatives` for whatever would break _this_ shot:

- people scenes → `"no extra people in background"`, `"no warped hands"`
- roofs/exteriors → `"no sagging rooflines"`, `"no floating debris"`
- interiors → `"no impossible reflections"`, `"no warped door frames"`
- before/after → `"no mismatched lighting between halves"`

---

## Step 5 — Ratio intent (1:1 vs 9:16 are different ads)

Don't render the same composition into both crops. The helper injects the
framing guidance (`helper.RATIO_INTENT`); you place the subject for it:

- **1:1 (feed/grid)** — the workhorse. Single focal subject, legible as a
  ~400px thumbnail, offer in the lower third. This is the ratio for **concept
  previews** (the worker renders previews at 1:1 only).
- **9:16 (story/reel)** — full-bleed vertical, subject _fills_ the frame,
  keep the **top safe** (status bar / profile chrome) and the **bottom safe**
  (caption + CTA bar). Text stacks vertically. Re-frame the subject taller;
  don't just letterbox the square.
- **16:9** — landscape filler for certain placements; horizon-led with the
  subject offset and room for a headline beside it. Rarely the lead ratio.

**Finals** are typically rendered at both **1:1 and 9:16** so the buy can run
feed and stories from one concept. Author the concept knowing it must work
tall _and_ square.

---

## Putting it together: a complete 4-concept set

```python
from helper import build_image_brief, build_concept, assert_distinct_concepts

brief = build_image_brief(
    market="Austin TX roofing",
    offer_text="$99 roof inspection",
    angles=["before_after", "owner_led_trust", "savings", "urgency"],
    service_type="roofing",
    audience="homeowners 35-65, post-storm",
)

concepts = [
    build_concept(
        angle="before_after",
        concept_label="storm damage to flawless roof",
        subject="a single suburban roof, left half storm-worn with missing "
                "shingles, right half flawless new charcoal architectural shingles",
        setting="a two-story Austin home, clear transition down the ridge line",
        lighting="bright clean daylight, even soft shadows",
        lens="35mm, f/4, sharp throughout",
        mood="satisfying, decisive, premium",
        ratio="1x1",
        extra_negatives=["no mismatched lighting between halves", "no debris"],
    ),
    build_concept(
        angle="owner_led_trust",
        concept_label="owner handshake",
        subject="a friendly roofer in his 40s in a clean branded navy polo "
                "shaking hands with a relieved homeowner",
        setting="in front of a well-kept home with a freshly shingled roof",
        lighting="warm golden-hour side light, gentle rim light",
        lens="35mm, f/2.8, slight depth of field",
        mood="trustworthy, relieved, approachable",
        ratio="1x1",
        extra_negatives=["no ladder in frame", "no extra people in background"],
    ),
    build_concept(
        angle="savings",
        concept_label="ninety-nine dollar value hero",
        subject="a confident homeowner reviewing a clean one-page roof report "
                "on a clipboard, nodding, smart and satisfied",
        setting="on a tidy front porch of an Austin home, roof visible behind",
        lighting="soft overcast diffusion, flattering and even",
        lens="50mm, f/2.8",
        mood="smart, reassured, value-forward",
        ratio="1x1",
        offer_text="$99 roof inspection",
        extra_negatives=["no warped text on the clipboard paper"],
    ),
    build_concept(
        angle="urgency",
        concept_label="storm season sky",
        subject="a sturdy well-maintained roof under a dramatic approaching "
                "storm sky, calm-before-the-storm tension",
        setting="a suburban Austin neighborhood, wind in the trees",
        lighting="moody pre-storm light, shafts of sun through dark clouds",
        lens="24mm, f/5.6, wide and deep",
        mood="decisive, protective, act-now",
        ratio="1x1",
        extra_negatives=["no lightning bolts", "no fake countdown timer"],
    ),
]

assert_distinct_concepts(concepts)  # raises if any two share an angle/prompt
# `concepts` is now render-ready: list[{concept, prompt, offer_text?}]
```

The `concepts` list is exactly the `items` array the `pipeline-operator`
skill sends to the worker `render` tool for a `concept_preview` batch.

---

## Self-check before you hand off a set

1. Is the **offer concrete** (number + service + low commitment)? If not, did
   you flag it and propose a sharper one?
2. Are there **>= 2 (ideally 4) concepts**, each on a **distinct angle**?
   (`assert_distinct_concepts` will tell you.)
3. Does every concept have **one clear focal subject**, **named lighting**,
   and a **photographer's lens**?
4. Is on-image text **absent on previews** (or <= 6 words on a final), with
   real copy reserved for the caption?
5. Did you add **concept-specific negatives** for this shot's failure modes?
6. For finals: does the concept work **both 1:1 and 9:16**?

If all six are yes, the set is ready to render. If any is no, fix it before
spending — a re-render is cheaper to avoid than to redo.

## Related

- `pipeline-operator` — the playbook that drives this skill across a live
  pipeline (read state → author brief → render concepts → render finals),
  one spend gate per render batch.
- The worker `render` tool consumes the `{concept, prompt, offer_text?}`
  items this skill produces; previews render 1:1 @ 1K, finals render 1:1 +
  9:16 @ 2K.
