# `image-ad-authoring` — skill + deploy notes

The creative-methodology skill for **paid local-services image ads**. It
encodes how to author a tight brief, N distinct concepts, and photoreal
generation prompts that survive a paid render. `SKILL.md` is the judgment;
`helper.py` is the deterministic scaffolding the agent assembles with.

This skill has **no dashboard/Supabase coupling** — it is pure authoring
logic. It pairs with `pipeline-operator`, which calls the worker render tools
to actually spend on renders. The `pipeline-operator` skill is the only thing
that turns the dicts this skill builds into network calls.

## Layout

```
ekko-skills/image-ad-authoring/
├── SKILL.md           # the creative playbook (offer framing, angles,
│                      #   composition, lighting/lens, on-image text,
│                      #   negative cues, 1:1 vs 9:16 intent)
├── helper.py          # pure utilities: build_image_brief, build_concept,
│                      #   build_concept_prompt, normalize_angles,
│                      #   validate_onimage_text, assert_distinct_concepts
├── README.md          # this file
└── tests/
    └── test_helper.py # pytest unit tests (no mocks needed — pure functions)
```

## Public surface (`helper.py`)

| Function                        | Purpose                                                              |
| ------------------------------- | -------------------------------------------------------------------- |
| `build_image_brief(...)`        | Assemble + validate the worker `image_payload` (market/offer/angles) |
| `normalize_angles(...)`         | Validate, de-dupe, order-preserve an angle list                      |
| `build_concept_prompt(...)`     | Compose one photoreal prompt from craft fields + negatives           |
| `build_concept(...)`            | Build a render-ready `{concept, prompt, offer_text?}` item           |
| `validate_onimage_text(...)`    | Lint a short on-image offer stamp (<= 6 words)                       |
| `assert_distinct_concepts(...)` | Guard that a concept set is genuinely varied before spend            |

All raise `ImageAdAuthoringError` on bad input. No env, no network.

## Local tests

The skill depends only on the Python stdlib (no `httpx`, no Supabase).

```bash
cd ekko-skills/image-ad-authoring
python3 -m venv .venv
.venv/bin/pip install pytest
.venv/bin/pytest tests/ -v
```

`.venv/` is local-only — do not commit it.

## VPS deployment

Same dual-surface model as the sibling skills. The Hermes container
bind-mounts the skills directory; deploying is copy + restart.

1. Sync the skill into the runtime skills directory:

   ```bash
   rsync -a --delete \
     ekko-skills/image-ad-authoring/ \
     vps:/opt/data/skills/image-ad-authoring/
   ```

2. No env vars are required — this skill reads nothing from the environment.

3. Restart the agent so it reloads the skills index:

   ```bash
   ssh vps 'docker restart hermes-agent-operator'
   ```

   (The operator runs in `hermes-agent-operator`; this skill is loaded by the
   operator agent, not Ekko.)

4. Verify it registered:

   ```bash
   ssh vps 'docker exec hermes-agent-operator hermes skills list \
     | grep image-ad-authoring'
   ```

## Mirror to the `silva-1337/ekko` repo

As with the other skills, mirror the directory into the Ekko image's
`skills/` so a base-image rebuild bakes it in. That mirror is a follow-up
after this lands; it is intentionally out of scope here.

## Pairs with

- `pipeline-operator` — the operator playbook that drives this skill across a
  live pipeline and gates the spend (render) calls via the approval plugin.
