---
name: video-voiceover-broll
description: Build a voiceover + b-roll video ad script for VoxHorizon. Use when the operator approves a video brief whose `script_outline` needs to be turned into actionable per-segment scripts, voiceover direction, and b-roll search themes. Output is a single strict JSON object (hook + segments[] + outro) consumed downstream by ElevenLabs (voice) and the b-roll selector. Companion to `video-talking-head` (avatar-led); this skill is voice + cutaways, no avatar.
---

# Video: Voiceover + B-roll

This skill exists for one reason: voiceover + b-roll videos convert when the hook lands in <3s, the script paces with the b-roll, and the CTA is unmissable.

Use this skill to turn a video brief into a concrete production plan: hook line, per-segment scripts (one beat each), b-roll search themes, voiceover pace, and caption emphasis points. The output feeds ElevenLabs for VO generation and the b-roll selector (V2-5) for clip retrieval, so be literal, not poetic.

## When to use

- A `video_briefs` row is approved and its `payload.script_outline` needs to become an actionable production plan.
- The operator says "rewrite the script" or "redo the voiceover plan" in chat.
- The daily video-ad cycle needs a script before voiceover generation.
- `broll_selection_mode` is `auto`, `review_each`, or `review_low_confidence`. All three pull from the b-roll themes you emit.

Do NOT use this skill for talking-head ads (use `video-talking-head`), image ads (use `image-ad-prompting`), or shared-screen / split-screen videos.

## Inputs

You receive a `video_briefs` row payload. Fields that drive the script:

| Field                        | Source        | Use                                                                                                        |
| ---------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- | ---------- | ---------------------------------- |
| `script_outline.hook`        | operator seed | rewrite freely; this is a starting point, not a constraint                                                 |
| `script_outline.segments[]`  | operator      | each has `topic`, `duration_s`, `broll_theme`. Keep the beat order but rewrite VO + tighten b-roll queries |
| `target_duration_s`          | brief         | total runtime (cap 60s in v1)                                                                              |
| `voice_id`                   | brief         | ElevenLabs voice id, used downstream. Write VO that fits the voice's range (energetic vs warm vs deadpan)  |
| `hook_style`                 | brief         | `curiosity                                                                                                 | pattern_interrupt | data_shock | question`. Picks the hook template |
| `dimensions`                 | brief         | usually `9x16`; affects b-roll framing ("vertical handheld" vs "wide drone")                               |
| `captions_style`             | brief         | drives emphasis density                                                                                    |
| `client_id` + client profile | linked        | informs region, niche, banned words, the actual offer                                                      |

Pulled automatically when available: `client-profiles/{slug}.json`, `knowledge/winning-copy-registry.md`, `docs/ad-copy-standards.md` (banned words).

## Output schema

Return ONE JSON object matching this shape exactly. No prose around it.

```json
{
  "hook": "Stop scrolling if you live in Texas and your roof is older than 10 years.",
  "segments": [
    {
      "idx": 0,
      "topic": "establish problem",
      "duration_s": 4.5,
      "voiceover_text": "Most homeowners don't realize their shingles are already failing.",
      "voiceover_direction": "energetic, slight pause after 'failing'",
      "broll_query": "texas suburban roof drone shot",
      "broll_intent": "establish home + roof context, wide vertical drone",
      "captions_emphasis": ["failing"]
    },
    {
      "idx": 1,
      "topic": "show the cost",
      "duration_s": 5.0,
      "voiceover_text": "By the time you spot a leak, you're looking at 12 grand minimum.",
      "voiceover_direction": "deadpan, hit the number hard",
      "broll_query": "water damage ceiling stain interior",
      "broll_intent": "consequence frame, tight handheld, illustrate the cost",
      "captions_emphasis": ["12 grand"]
    }
  ],
  "outro": {
    "voiceover_text": "Tap below to claim a free quote. Takes 30 seconds.",
    "cta_overlay": "Claim Free Quote",
    "duration_s": 3.5
  },
  "total_duration_s": 30
}
```

Hard rules on the output:

- Top-level keys exactly: `hook`, `segments`, `outro`, `total_duration_s`.
- `segments` is an array with at least 1 and at most 4 entries.
- Every segment carries all seven listed keys (no extras, no omissions).
- `idx` is 0-based and contiguous.
- `total_duration_s` equals the sum of (hook duration + every `segment.duration_s` + `outro.duration_s`), within ±1s of `target_duration_s`.
- Numbers are numbers, not strings. Booleans where called for. Empty `captions_emphasis` is `[]`, not omitted.

## Hook templates by `hook_style`

Pick the matching block. Then customize: insert the region, the offer, the cost number, the time window. Stay under 4s of speech.

### `curiosity`

- "Most [target] don't know..."
- "If your [thing] looks like this, you're..."
- "Here's what I wish I'd known before [event]."
- "There's one thing every [target] gets wrong about [topic]."

### `pattern_interrupt`

- "Stop scrolling if you live in [region]."
- "[N] [thing] every Texas homeowner needs to see."
- "Don't replace your [thing] until you watch this."
- "Skip ahead. This isn't another roofing ad. It's the one [target] actually need."

### `data_shock`

- "[N]% of homes in [region] have [problem] right now."
- "The average [X] in [region] is [$Y]. Here's how to pay [$Y - reduction]."
- "[year] data: [stat]."
- "[N] out of [M] [target] in [region] are paying double for [thing]."

### `question`

- "Why are [target] paying [$N] for [thing]?"
- "What if [thing] only took [time]?"
- "[Y/N question that flips an assumption]"
- "Would you let your [thing] go [N] more years without [action]?"

If a hook from `knowledge/winning-copy-registry.md` already won on a comparable niche/region/offer, prefer that pattern over a fresh template.

## Pacing rules

- **Hook** 2-4s, must land within the first 3s of total runtime. If the hook itself is 4s, no preamble can precede it.
- **Body segments** 4-8s each. Hard cap of 4 body segments for any video <30s. For 30-60s videos, up to 4 segments, lengthening individual segments rather than adding more.
- **Outro / CTA** 3-5s. Always end with a verb ("Tap", "Claim", "Get", "Book") and a concrete deliverable ("Free Quote", "Roof Check", "Estimate"). No "Click for more info".
- **Total runtime** equals `target_duration_s` ±1s at ElevenLabs default speed (1.0). If you push speed (1.1-1.3 for energy), say so in `voiceover_direction` and bake the duration math at the chosen speed.
- **Beat density**: aim for ~2 to 2.5 words per second average. Faster = more energy, but the captions stop landing if you exceed 3.

## Voiceover direction language

Use plain stage directions. ElevenLabs respects prosody markup but operators read the JSON before VO gen, so keep it human.

Good directions:

- "energetic, slight rise on 'free'"
- "deadpan, ironic"
- "warm, conspiratorial whisper"
- "fast, urgent, no breath"
- "slow, deliberate, hit the number"
- "matter-of-fact, no enthusiasm"

Avoid em dashes anywhere in the output (Ekko house rule). Use commas, periods, or line breaks for pauses. Avoid "(pause)"; bake it into the prose with punctuation.

## B-roll query rules

Each segment's `broll_query` becomes a literal search string passed to yt-dlp / TikTok / stock libraries by the b-roll selector (V2-5). It MUST be:

- A real search string. No quotes, no AND/OR, no glob characters.
- Region-specific when possible. "Texas roof contractor" beats "roof contractor". "Dallas suburban home" beats "suburban home".
- Action-oriented and concrete. "hammering shingles on roof" beats "roof contractor working". "water dripping from ceiling" beats "water damage".
- Visually unambiguous. Avoid abstract concepts. The selector has to score whether a clip matches.
- ≤ 60 characters.
- Lower case, no punctuation except spaces.

`broll_intent` is the _why_ the selector uses to score downstream confidence. Include the visual frame (wide drone / tight handheld / locked-off / POV), the emotional read (urgent / calm / aspirational / warning), and the role in the script (establish / illustrate cost / show solution / social proof / CTA setup). For 9x16 dimensions, explicitly call vertical framing in the intent.

## Captions style guidance

- `bold_yellow`: 1-2 words per frame, animated bounce, max emphasis. Pick the strongest word per segment.
- `minimal_white`: full sentences, fade in/out, low-key. Emphasis list is shorter (1 word per segment max, often empty).
- `brand`: VoxHorizon brand styling (currently same behavior as `bold_yellow`; brand palette is TBD).

`captions_emphasis` is a list of literal words from `voiceover_text`, in order of appearance, that get the bold-stamp treatment. Don't include filler ("the", "and", "is"). Pick numbers, verbs, and proper nouns first.

## Hard constraints (Ekko house rules)

- No em dashes anywhere.
- No corporate banned words (transform, revolutionary, cutting-edge, premium, luxury, state-of-the-art, unlock, unleash, elevate). Pull the latest list from `docs/ad-copy-standards.md` if in doubt.
- No "Welcome!" / "Hi everyone!" / "What's up guys" openers.
- No sycophancy ("Hope this helps!", "Great question").
- No filler that adds no information ("Let's dive in", "Without further ado").
- CTA verb-led and concrete ("Claim Free Quote", not "Click for more info"; "Book Your Roof Check", not "Learn more").
- The hook does NOT repeat the offer. It sets up curiosity, pattern interrupt, or shock. The offer lands in the body or outro.
- 9x16 dimensions imply portrait composition. Call out vertical framing in every `broll_intent`.
- 8th-grade vocabulary maximum. The audience is blue-collar homeowners making expensive decisions, not analysts.
- Numbers in body copy where they fit naturally ("12 grand", "30 seconds", "15 years"). Concrete beats abstract.
- One offer per video. Don't stack.

## Self-audit before returning JSON

Run through this list. If any check fails, fix and re-emit.

1. Hook ≤ 4s of speech AND lands in the first 3s of total runtime? (Compute: speech words / words-per-second.)
2. Sum of `hook` duration + every `segment.duration_s` + `outro.duration_s` == `total_duration_s` AND within ±1s of `target_duration_s`?
3. Each segment's `broll_query` is a literal yt-dlp / TikTok search string, not a description of the clip you wish existed?
4. CTA verb-led and concrete?
5. Zero em dashes anywhere in `voiceover_text`, `voiceover_direction`, or `cta_overlay`?
6. No banned corporate words? (Cross-check `docs/ad-copy-standards.md` if available.)
7. `captions_emphasis` entries all appear verbatim in `voiceover_text`?
8. `idx` is 0-based contiguous?
9. JSON is valid (commas, brackets, quotes)?
10. Output is ONLY the JSON object. No preamble, no follow-up commentary, no markdown fence around it unless the caller asked for one.

## Related

- `references/winning-hooks.md`: proven hook patterns by niche.
- `references/broll-themes.md`: common b-roll categories with example queries.
- Sibling skill `video-talking-head`: when the brief asks for an avatar / face-on-camera ad instead.
- Upstream SOP this is built from: `~/github/voxhorizon-marketing-dept/workspace/knowledge/14-b2c-voiceover-broll-ads-sop.txt` (the AI Ads Masterclass course material).
- Sibling SOP shape: `~/github/voxhorizon-marketing-dept/workspace/docs/sop-video-talking-head.md`.
