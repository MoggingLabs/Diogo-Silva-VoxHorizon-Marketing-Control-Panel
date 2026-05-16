# worker/skills/

Anthropic-format skills loaded by the VoxHorizon worker when planning or generating creative output. Mirrors the convention used in the upstream marketing department repo (`silva-1337/voxhorizon-marketing-dept/skills/`) so that skills can be lifted between repos without restructuring.

## Layout

```
worker/skills/
├── README.md                       (this file)
└── <skill-name>/
    ├── SKILL.md                    required; YAML front-matter + body
    └── references/                 optional support material
        └── *.md
```

Each top-level directory is a single skill. The directory name MUST match the `name:` field in the SKILL.md front-matter.

## SKILL.md format

```markdown
---
name: <skill-slug>
description: <one-line trigger + scope statement>
---

# Skill title

Body content. Trigger conditions, inputs, output schema, rules.
```

The front-matter has exactly two keys: `name` and `description`. Anything else lives in the body. Skill name slugs are kebab-case (`video-voiceover-broll`, not `VideoVoiceoverBroll`).

## Discovery

The worker resolves skills via a path config (defaulting to `worker/skills/`). On boot it walks the directory, parses each `SKILL.md`, and registers the skill by its `name` field. References in `references/` are loaded on demand by the skill body, not eagerly.

The control-panel UI doesn't load skills directly; they're consumed by the Claude planner inside the worker. Adding a new skill is a code change to this directory plus a worker restart.

## Authoring rules

- One concern per skill. If a SOP needs three different decision modes, that's three skills.
- The front-matter `description` is the trigger. It should answer "when do I fire this?" in one line.
- Inputs section is mandatory if the skill consumes a payload.
- Output schema (when applicable) is JSON-as-code in a fenced block.
- House rules: no em dashes, no banned corporate words, no sycophancy. See `~/github/voxhorizon-marketing-dept/workspace/docs/ad-copy-standards.md` upstream for the canonical banned-words list.
