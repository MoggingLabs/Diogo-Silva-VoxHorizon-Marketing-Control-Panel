# CI guide

This document describes the pre-merge CI gate (`.github/workflows/ci.yml`), the
deploy guard (`.github/workflows/deploy-stack.yml`), and the manual-merge
fallback to use when GitHub Actions billing is unavailable.

## Gate split: cheap vs expensive

CI is split into two tiers so a failure (or a billing lapse) in the heavy tier
never blocks the cheap signal.

### Cheap gate (always runs)

These jobs need no Docker services, finish in a minute or two, and do not depend
on the change-detection job, so they always produce a signal:

- `web-checks` - TypeScript typecheck, ESLint, and Vitest unit tests with the
  >=90% coverage gate.
- `workflow-lint` - actionlint over `.github/workflows`.
- `sql-lint` - sqlfluff over `db/migrations` (postgres dialect, lint-only),
  config-driven (`db/.sqlfluff`) and version-pinned. BLOCKING; see "SQL lint"
  below. The authoritative SQL correctness gate is `migration-apply`.

### Expensive gate (path-filtered)

A `changes` job (using `dorny/paths-filter`) computes which source areas a PR
touched. Each heavy job runs only when its sources changed:

| Job                  | Runs when                          | What it does                                                        |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `web-build`          | web sources change                 | Production `pnpm build`.                                            |
| `worker`             | `worker/**` changes                | `uv run pytest` (unit + >=90% coverage gate).                      |
| `worker-integration` | `worker/**` or `db/migrations/**`  | Postgres service + migrations + `uv run pytest -m integration`.     |
| `migration-apply`    | `db/migrations/**` changes         | Apply `0001..N` to a clean Postgres, fail on first error.          |
| `e2e`                | web, worker, db, or `tests/e2e/**` | Both verticals via a spec matrix (image, video, both, launch).     |

On push to main (the post-merge guard) there is no PR diff base, so the filters
resolve true and the full gate runs.

### Why the split limits blast radius

The cheap jobs are independent of the `changes` job and of every heavy job. If
the heavy tier cannot run at all (for example, GitHub Actions billing lapses and
only a subset of runners are available, or a Docker-service job is broken), the
cheap gate still runs and still reports typecheck, lint, unit, workflow-lint, and
sql-lint. A reviewer keeps a real, fast correctness signal even when the
expensive tier is degraded. Conversely, a build break or a flaky e2e never blocks
the cheap checks from going green, because they are separate jobs with no shared
dependency.

## SQL lint

`sql-lint` runs sqlfluff over `db/migrations` and is a BLOCKING gate. It is
driven by `db/.sqlfluff` and the sqlfluff version is pinned in the workflow
(`uvx --from "sqlfluff==4.2.1" ...`) so an upstream release cannot turn the gate
red without a repo change. The command is lint-only and never rewrites files.

`db/.sqlfluff` sets the postgres dialect and the `raw` templater, and excludes
the purely cosmetic layout rules (spacing/indentation/line-length/aliasing/etc.)
that the existing hand-aligned, already-deployed migrations predate. Excluding
those rules (rather than auto-reformatting 40+ forward-only files) keeps the gate
focused on REAL problems: parse errors and the correctness-relevant rules stay
on. Run it locally exactly as CI does:

```bash
uvx --from "sqlfluff==4.2.1" sqlfluff lint db/migrations --config db/.sqlfluff
```

### The `ALTER FUNCTION ... SET search_path = a, b` parse gap

sqlfluff's postgres dialect cannot parse a comma-separated value list in
`ALTER FUNCTION ... SET <param> = <a>, <b>` (it reports a `PRS` parse error on
the comma), even though the SQL is valid and deployed. Two merged migrations
(`0011_enable_rls_lockdown.sql`, `0029_harden_rebuild_function_search_path.sql`)
use it. Because forward-only migrations are never edited, they are listed in
`db/.sqlfluffignore`. A NEW migration that needs this construct should add an
inline `-- noqa: PRS` on the offending line instead of being added to the ignore
file.

The authoritative SQL correctness gate remains the `migration-apply` job: it
applies the real migration chain to a real Postgres and fails on any real error,
which is the property that actually matters for a forward-only migration set.

## The `integration` marker contract (epic #421)

`worker-integration` runs `pytest -m integration` against a real Postgres
reachable at `DATABASE_URL`. The `integration` marker is the contract with the
integration-test tier being built in parallel under epic #421: those tests carry
`@pytest.mark.integration` and connect to this Postgres service.

Until #421 lands marked tests, `-m integration` collects zero tests and pytest
exits with code 5 ("no tests collected"). The job treats exit 5 as success so
the wiring is in place without going red prematurely. The job also neutralises
the repo-wide coverage `addopts` (it passes `-o addopts=` and `--no-cov`),
because the >=90% coverage gate is meaningless for the initially empty
integration selection. The unit `worker` job remains the owner of the coverage
gate.

When #421 merges its integration tests, no change to this workflow is required:
the marked tests will simply start being collected and run.

## Deploy auto-trigger guard

`deploy-stack.yml` is `workflow_dispatch`-only on purpose for the duration of the
pipeline rebuild. Auto-deploy on push to main is disabled so that CI-gated merges
to main never touch the live VPS stack. Deploys during the rebuild are deliberate
and manual: use the Actions "Run workflow" button.

The `on:` block in `deploy-stack.yml` carries an explicit guard banner
(`DEPLOY AUTO-TRIGGER GUARD ... DO NOT RE-ENABLE WITHOUT SIGN-OFF`). Do not add a
`push:` trigger there as a convenience; its absence is intentional. Re-enable the
push trigger only when the rebuild is complete and a maintainer has signed off.

## Manual-merge fallback (Actions billing blocked)

GitHub Actions billing is currently blocked, which means the gate may not run on
a PR. When that happens, fall back to running the equivalent checks locally and
merging by hand. The cheap gate is the minimum bar; run the heavy checks too when
your change touches their sources.

### 1. Run the cheap gate locally

```sh
pnpm install --frozen-lockfile
pnpm tsc --noEmit
pnpm lint
pnpm test:coverage

# workflow lint (downloads actionlint on demand via uvx)
uvx actionlint

# sql lint (pinned + config, exactly as CI runs it)
uvx --from "sqlfluff==4.2.1" sqlfluff lint db/migrations --config db/.sqlfluff
```

### 2. Run the heavy checks that match your change

Worker unit tests:

```sh
cd worker
uv sync --frozen --extra dev
uv run pytest
```

Worker integration tests (needs a local Postgres on `DATABASE_URL`):

```sh
# start a throwaway Postgres
docker run --rm -d --name vox-ci-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres

# apply the forward-only chain in order
for f in db/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  PGPASSWORD=postgres psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

# run the integration tier (exit 5 = none collected yet, that is fine)
cd worker
uv run pytest -m integration -o addopts="" --no-cov

docker rm -f vox-ci-pg
```

The e2e suite needs the full local Supabase stack plus the worker and the Next
server. It is impractical to reproduce by hand for a quick fallback merge; rely
on the local Supabase stack and `pnpm test:e2e` only when the change is in the
e2e surface itself. For most fallback merges the cheap gate plus the relevant
unit and migration checks are sufficient.

### 3. Merge by hand

Once the relevant checks pass locally, record what you ran in the PR description
(commands and results) so the review trail is explicit, then merge. Do NOT deploy
as part of this: `deploy-stack.yml` stays manual and is a separate, deliberate
action.

### Blast-radius note

Because the cheap gate is independent, a billing lapse degrades CI but does not
blind you: the local cheap-gate commands above mirror the always-on jobs exactly,
so the fallback reproduces the same minimum bar the gate enforces.
