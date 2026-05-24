---
name: video-ad-authoring
description: |
  Author high-converting local-services VIDEO ads end to end: a tight brief,
  N distinct script concepts, and segment-by-segment scripts (hook, timed
  segments with voiceover + b-roll briefing, outro) that survive a paid
  generation pass. Use this whenever you need to turn a market + offer into
  ad-ready short-form video concepts (roofing, HVAC, plumbing, dental, med-spa,
  home services, legal, auto). It encodes offer framing, angle selection, the
  3-second hook, a humanized voiceover (no AI-tell words), b-roll intent, caption
  emphasis, and 9:16 pacing. Trigger phrases: "write a video-ad brief", "author
  video concepts", "give me 3 video script concepts", "write a short-form ad
  script", "video concepts for a $99 inspection offer", "local services video
  ads".
---

# video-ad-authoring

This is the creative playbook for paid local-services VIDEO ads. It is the
sibling of `image-ad-authoring`: same strategy (market, offer, angles), but the
deliverable is a short-form 9:16 script, not a single still. `SKILL.md` is the
judgment; `helper.py` is the deterministic scaffolding that validates every brief,
segment, script, and concept so a malformed structure never reaches a paid
voiceover or generation pass.

The pipeline that runs your output is gated: the manager reviews concepts before
any spend, and generation only proceeds on approved concepts. Your job is to hand
over a set of genuinely different, production-ready scripts. The `pipeline-operator`
skill turns the dicts you build here into `video_brief` and `video_render` calls.

## The one rule that beats every other rule

The first 3 seconds decide everything. A short-form ad lives or dies on the hook:
if the opening line plus the opening shot do not stop the scroll, nothing after it
matters. Write the hook first, make it specific to the buyer's real problem, and
make every segment earn the next three seconds of attention.

Right behind it: write a voiceover a real person would actually say out loud. The
fastest way to lose a local buyer's trust is a line that sounds machine-written.
The helper rejects the worst AI-tell words; you own the rest.

## Step 1 - The brief (strategy in one object)

Build the brief with `build_video_brief(...)`. Required: `market`, `offer_text`,
`angles`, `target_duration_s`, `voice_id`. The offer is the single biggest
conversion lever, so keep it concrete and in the buyer's words ("$99 roof
inspection", not "affordable roofing solutions").

```python
from helper import build_video_brief

brief = build_video_brief(
    market="Austin TX roofing",
    offer_text="$99 roof inspection",
    angles=["before_after", "urgency", "owner_led_trust"],
    target_duration_s=24,
    voice_id="<elevenlabs-voice-id>",
    hook_style="problem_callout",
    broll_selection_mode="auto",
    service_type="roofing",
    audience="homeowners 35-65, recent storm",
)
```

`target_duration_s` is the finished length you are aiming for (6-90s; short-form
ads land best at 15-30s). `voice_id` is required because the voiceover stage 409s
without it. `broll_selection_mode` is `auto` for unattended generation; use
`review_each` only when the manager wants to curate every clip.

### When client context is present

Read the client context first (`pipeline_operator_client_read`). Author from the
client's REAL offers, brand voice, proof points, and local market. Honor
`offer_constraints` (the do-not-say rules) verbatim in every voiceover line. Never
invent a guarantee, a price, or a credential the client did not give you.

## Step 2 - Choose distinct angles (different reasons to believe)

Each angle becomes one concept, so the angle list is your concept plan. Use the
closed vocabulary in `helper.ANGLES`:

- `before_after`: the visible transformation the buyer wants.
- `owner_led_trust`: a real owner/operator on camera; a face and credibility.
- `social_proof`: volume of happy customers, reviews, neighborhood saturation.
- `urgency`: a reason to act now (season, slots, weather, deadline).
- `savings`: the money math; the offer as the hero.
- `problem_agitation`: the cost of NOT acting (damage, risk, embarrassment).
- `authority`: licensed, certified, years in business, guarantees.

Pick angles that give the manager a real choice. Two concepts on the same angle
is a wasted slot; `assert_distinct_concepts` enforces distinct angles and distinct
hooks.

## Step 3 - Write the script (hook, segments, outro)

A script is a hook, 1 to 4 timed segments, and an outro. Build each segment with
`build_segment(...)`, then assemble with `build_script(...)`. Segment `idx` must
be 0-contiguous and the segment durations must sum to within a few seconds of
`target_duration_s`.

The segment fields, and why each matters:

- `idx`: 0-based order. Contiguous, no gaps.
- `topic`: what this beat is about, in a few words.
- `duration_s`: how long this beat runs (2-20s). Keep early beats short.
- `voiceover_text`: the exact words spoken. Short (<= 60 words), plain, human.
- `voiceover_direction`: delivery note for the voice (calm, urgent, warm).
- `broll_query`: what to search or generate for the footage (see Step 5).
- `broll_intent`: what the footage must DO, from `helper.BROLL_INTENTS`.
- `captions_emphasis`: the words to visually punch in the burned-in captions.

```python
from helper import build_segment, build_script

segments = [
    build_segment(
        idx=0, topic="storm damage hook", duration_s=5,
        voiceover_text="One storm and a small leak turns into a ceiling repair.",
        voiceover_direction="urgent, plain",
        broll_query="rain on a residential roof, dramatic sky",
        broll_intent="establish",
        captions_emphasis=["one storm", "ceiling repair"],
    ),
    build_segment(
        idx=1, topic="the fix", duration_s=11,
        voiceover_text="We inspect the whole roof and show you photos of what we find.",
        voiceover_direction="calm, reassuring",
        broll_query="roofer inspecting shingles, taking phone photos",
        broll_intent="demonstrate",
        captions_emphasis=["inspect", "photos"],
    ),
]
script = build_script(
    hook="Is your roof one storm away from a leak?",
    segments=segments,
    outro="Book your $99 inspection before storm season.",
    target_duration_s=24,
)
```

## Step 4 - The voiceover (the humanizer pass)

Every `voiceover_text` runs through `validate_voiceover_text`, which caps length
and rejects the AI-tell words in `helper.BANNED_VOICEOVER_WORDS` ("unleash",
"elevate", "game-changer", "seamless", "look no further", and friends). Those
words are an instant tell that a machine wrote the ad. Rewrite around them in
plain spoken language: say what you would say to a neighbor over the fence.

Read each line out loud. If it is hard to say in one breath, it is too long or
too written. Contractions are good. One idea per line.

## Step 5 - Brief the b-roll (query, intent, and compliance)

Each segment names the footage twice: `broll_query` (what to find or generate)
and `broll_intent` (what it must accomplish). The pipeline sources clips two ways
and the manager curates the mix: generated clips (kie video) and licensed stock
(search). Two compliance rules you must author around:

- Generative footage of the ACTUAL service can read as misrepresentation to the
  ad platforms. Keep generated b-roll ABSTRACT (weather, a generic roofline, a
  hand on a clipboard), and prefer the client's own footage or licensed stock for
  anything that depicts the real work or result.
- Stock is not automatically licensed. Brief queries that can be satisfied by
  cleared sources; the compliance stage rejects unlicensed clips.

Choose `broll_intent` deliberately: `establish`, `demonstrate`, `before_after`,
`proof`, `product_focus`, `lifestyle`. The compliance review keys on it.

## Step 6 - Captions emphasis

Short-form ads are watched on mute first. `captions_emphasis` is the handful of
words per segment the burned-in captions punch visually. Emphasize the offer, the
number, and the payoff word, not filler. Keep it to a few words per segment.

## Step 7 - Pace it (segments sum to the target)

`build_script` computes `total_duration_s` from the segment durations and checks
it lands within a few seconds of `target_duration_s`. If it is off, adjust segment
timings, do not pad the voiceover. Front-load value: the first segment is the
shortest and the sharpest.

## Putting it together: a complete 3-concept set

Author one concept per angle, then guard distinctness before you hand off:

```python
from helper import build_video_concept, assert_distinct_concepts

concepts = [
    build_video_concept(
        angle="problem_agitation", concept_label="storm-leak",
        hook="Is your roof one storm away from a leak?",
        segments=segments_a, outro="Book your $99 inspection before storm season.",
        target_duration_s=24,
    ),
    build_video_concept(
        angle="savings", concept_label="99-dollar-math",
        hook="A $99 inspection now beats a $9,000 repair later.",
        segments=segments_b, outro="Lock in your $99 inspection this week.",
        target_duration_s=24,
    ),
    build_video_concept(
        angle="owner_led_trust", concept_label="meet-the-owner",
        hook="I have inspected 2,000 Austin roofs. Here is what I look for.",
        segments=segments_c, outro="Book the owner-led $99 inspection.",
        target_duration_s=24,
    ),
]
assert_distinct_concepts(concepts)
# concepts is now ready: list[{concept, angle, script}]
```

Pass the brief and the concept set to `pipeline_operator_video_brief(...)` so the
whole plan persists, then trigger generation on the approved concepts.

## Self-check before you hand off a set

- Does every concept use a distinct angle AND a distinct hook?
- Does each hook name a real, specific buyer problem in the first line?
- Would each voiceover line survive being read out loud to a neighbor?
- Do the segment durations sum to within a few seconds of the target?
- Is every generated-b-roll query abstract enough to avoid a misrepresentation
  flag, and is every stock query satisfiable by cleared sources?
- Do `captions_emphasis` words land on the offer and the payoff, not filler?
- Are the client's `offer_constraints` honored in every line?

If any answer is no, fix it before you spend a render.

## Related

- `pipeline-operator`: the operator playbook that drives this skill across a live
  pipeline and gates spend (the `video_render` calls) via the approval plugin.
- `image-ad-authoring`: the still-image sibling; same brief strategy, different
  deliverable.
