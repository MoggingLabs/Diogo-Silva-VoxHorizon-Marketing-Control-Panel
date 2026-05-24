# Codegen and drift gates (E0.3)

The "single source of truth" for the schema is the Postgres database (its tables
and enums). Two generators reflect that source into the two languages the repo
uses, and two drift gates keep the committed copies honest. Nothing in the repo
should hand-maintain a second copy of a table shape or an enum value set.

```
Postgres DB (the source of truth)
        |
        |  pnpm regen:types   (supabase gen types typescript --linked)
        v
lib/supabase/types.gen.ts   <-- generator 1 output (TypeScript)
        |
        |  uv run python scripts/gen_db_enums.py
        v
worker/src/generated/db_enums.py   <-- generator 2 output (Python)
```

Generator 2 reads generator 1's output, so the Python enums share the same
upstream as the TypeScript types. They cannot disagree unless one of the gates
below is stale.

## Generator 1: TypeScript types

- Command: `pnpm regen:types`
- Output: `lib/supabase/types.gen.ts` (do not edit by hand)
- Consumers: the Supabase clients (`lib/supabase/*.ts`), the API routes, and the
  pipeline UI. `lib/pipeline/types.ts` derives `PipelineStatus` and
  `PipelineFormat` from the generated `Database["public"]["Enums"]`, so the
  exhaustive label and badge maps stop type checking if a stage is added or
  removed in the DB.

The bypasses that used to read tables and RPCs "by name" with `as never`
(because the table was not yet in `types.gen.ts`) have been removed from the
advance route now that the generated types cover them. New code should use the
generated `Database` types directly and never cast through `never`.

## Generator 2: Python DB enums

- Command (from `worker/`): `uv run python scripts/gen_db_enums.py`
- Output: `worker/src/generated/db_enums.py` (do not edit by hand)
- Consumers: the worker imports the generated tuples instead of hand-typing the
  same value sets (for example `pipeline_tools.PER_CREATIVE_STAGES` and the
  `ad_entity_kind` set in `integrations.py`).

The script parses the `Enums:` block of `lib/supabase/types.gen.ts` and emits an
ordered tuple plus a `Literal` type alias for each enum in its explicit
allow-list. Add a row to `EXPORTS` in the script when the worker needs another
enum.

## Generator 3: Python pipeline stages (E2.1 stage registry)

The 12-stage pipeline DAG plus each stage's advance mechanism
(gate/auto/decision/terminal), its UI class, its per-creative flag, its hard-gate
flag and its next-stage edge live ONCE in the checked-in TypeScript manifest
`lib/pipeline/stages.ts` (`PIPELINE_STAGE_REGISTRY`). The TS app derives its
`PIPELINE_STAGES` list, `advanceMechanism`, `stageClass`, `nextStage` and
`PER_CREATIVE_STAGES` from it. A third generator reflects the same registry into
Python so the worker stops hand-maintaining the `PipelineStage` Literal that used
to live in `services/pipeline_runner.py`.

```
lib/pipeline/stages.ts  (the stage registry, the E2.1 source of truth)
        |
        |  uv run python scripts/gen_pipeline_stages.py
        v
worker/src/generated/pipeline_stages.py   <-- PipelineStage Literal + order + maps
```

- Command (from `worker/`): `uv run python scripts/gen_pipeline_stages.py`
- Output: `worker/src/generated/pipeline_stages.py` (do not edit by hand)
- Consumers: `services/pipeline_runner.py` imports and re-exports `PipelineStage`,
  so existing callers (`routes/pipeline.py`, `routes/pipeline_tools.py`, ...) keep
  importing it from `services.pipeline_runner` unchanged.

The registry array order MUST equal the DB `pipeline_status_enum` value order;
that is asserted from both sides (`lib/pipeline/stages.parity.test.ts` and
`worker/tests/test_pipeline_stages_parity.py`), so the registry, the TS
derivations, the generated Python Literal and the DB enum cannot disagree without
a gate failing.

## Drift gates (owned by CI, epic #436)

CI must run both gates. Each regenerates from the source and fails if the
committed output moved.

### TypeScript types drift gate

```
pnpm install --frozen-lockfile
pnpm check:types-drift
# which is: pnpm regen:types && git diff --exit-code -- lib/supabase/types.gen.ts
```

`pnpm regen:types` needs the Supabase CLI and a linked project
(`supabase link --project-ref <ref>`), so this gate runs only where those are
available (CI / a maintainer machine), never against production from a worktree.
After regenerating, also run `pnpm typecheck` and `pnpm lint`.

### Python enums drift gate

```
cd worker
uv sync --extra dev --python 3.12
uv run python scripts/gen_db_enums.py --check
uvx ruff check
```

`--check` regenerates in memory and exits non-zero (with a fix hint) if
`worker/src/generated/db_enums.py` is stale. It reads the committed
`lib/supabase/types.gen.ts`, so run it after the TypeScript gate.

### Pipeline stage registry drift gate (E2.1)

```
cd worker
uv sync --extra dev --python 3.12
uv run python scripts/gen_pipeline_stages.py --check
uvx ruff check scripts/gen_pipeline_stages.py
```

`--check` regenerates in memory and exits non-zero (with a fix hint) if
`worker/src/generated/pipeline_stages.py` is stale relative to
`lib/pipeline/stages.ts`. The TS side of the same contract runs in the web unit
suite: `pnpm vitest run lib/pipeline/stages.parity.test.ts` fails if the registry,
the TS derivations, the DB enum or the generated Python Literal drift apart.
