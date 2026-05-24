# `video-ad-authoring` - skill + deploy notes

The creative-methodology skill for **paid local-services video ads**. It encodes
how to author a tight brief, N distinct script concepts, and segment-by-segment
short-form scripts (hook, timed segments with voiceover + b-roll briefing, outro)
that survive a paid generation pass. `SKILL.md` is the judgment; `helper.py` is
the deterministic scaffolding the agent assembles with.

This skill has **no dashboard/Supabase coupling** - it is pure authoring logic.
It pairs with `pipeline-operator`, which calls the worker video tools to actually
spend on generation. It is the still-image sibling of `image-ad-authoring`: same
brief strategy, a script instead of a single still.

## Layout

```
ekko-skills/video-ad-authoring/
|- SKILL.md           # the creative playbook (hook, angles, script structure,
|                     #   humanized voiceover, b-roll intent, captions, 9:16 pacing)
|- helper.py          # pure utilities: build_video_brief, build_segment,
|                     #   build_script, build_video_concept, normalize_angles,
|                     #   validate_voiceover_text, assert_distinct_concepts
|- README.md          # this file
|- tests/
   |- test_helper.py  # pytest unit tests (no mocks needed - pure functions)
```

## Public surface (`helper.py`)

| Function                        | Purpose                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `build_video_brief(...)`        | Assemble + validate the worker `video_payload` (market/offer/angles + video fields) |
| `normalize_angles(...)`         | Validate, de-dupe, order-preserve an angle list                         |
| `validate_voiceover_text(...)`  | Lint one voiceover line (word budget + banned AI-tell words)            |
| `build_segment(...)`            | Build one validated script segment (worker schema shape)               |
| `build_script(...)`             | Assemble hook + segments + outro; check count/contiguity/duration       |
| `build_video_concept(...)`      | Build one ideation concept: `{concept, angle, script}`                  |
| `assert_distinct_concepts(...)` | Guard that a concept set is genuinely varied before spend               |

All raise `VideoAdAuthoringError` on bad input. No env, no network. The segment
shape is kept in lock-step with the worker's video `script` substage validator so
an authored script passes generation.

## Local tests

The skill depends only on the Python stdlib (no `httpx`, no Supabase).

```bash
cd ekko-skills/video-ad-authoring
python3 -m venv .venv
.venv/bin/pip install pytest
.venv/bin/pytest tests/ -v
```

`.venv/` is local-only - do not commit it.

## VPS deployment

Same dual-surface model as the sibling skills. The Hermes container bind-mounts
the skills directory; deploying is copy + restart.

1. Sync the skill into the runtime skills directory:

   ```bash
   rsync -a --delete \
     ekko-skills/video-ad-authoring/ \
     vps:/opt/data/skills/video-ad-authoring/
   ```

2. No env vars are required - this skill reads nothing from the environment.

3. Restart the agent so it reloads the skills index:

   ```bash
   ssh vps 'docker restart hermes-agent-operator'
   ```

   (The operator runs in `hermes-agent-operator`; this skill is loaded by the
   operator agent, not Ekko.)

4. Verify it registered:

   ```bash
   ssh vps 'docker exec hermes-agent-operator hermes skills list \
     | grep video-ad-authoring'
   ```

## Pairs with

- `pipeline-operator` - the operator playbook that drives this skill across a live
  pipeline and gates the spend (the `video_render` calls) via the approval plugin.
- `image-ad-authoring` - the still-image sibling; same brief strategy.
