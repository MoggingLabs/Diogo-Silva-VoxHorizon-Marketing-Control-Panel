# ekko-skills/

This directory holds Hermes/Ekko skills owned by the VoxHorizon dashboard
team. A "skill" is a small bundle that Hermes (`silva-1337/ekko`) loads at
boot and exposes to the agent at chat time. Each skill is a self-contained
directory with a `SKILL.md` (frontmatter + body) and any helper code or
templates it needs.

## Why this directory exists in the dashboard repo

Skills that talk to the dashboard's Supabase tables, GHL webhooks, or the
dashboard's worker queue have schemas and contracts that move with the
dashboard repo. Keeping them here lets us:

- Review schema-aware changes alongside the dashboard migrations that
  motivate them.
- Run the skills' tests in the dashboard CI (so `dashboard-publish`
  helper-method changes get caught here, not in a separate Hermes PR).
- Let the operator deploy the skill with a single `scp -r` from this repo
  to the VPS without having to keep a separate skills repo in sync.

Skills that have no dashboard coupling (e.g. `campaign-brief`,
`image-ad-prompting`, `ad-creative`) continue to live in
`silva-1337/ekko` — they have no reason to depend on dashboard-internal
state.

## Layout

```
ekko-skills/
  README.md                  ← this file
  dashboard-publish/         ← publish artifact rows → Supabase
    SKILL.md
    README.md                ← per-skill deploy/usage notes
    helper.py
    tests/
      test_helper.py
  dashboard-chat-publish/    ← publish chat messages → Supabase (HI-10, J)
  dashboard-task-result/     ← publish Hermes task results → Supabase (HI-11, K)
```

Each skill's `README.md` is the canonical install + verify procedure for
that skill. Refer to it when copying a new build to the VPS.

## Two deployment surfaces

Each skill in this directory deploys to two places:

1. **VPS `/opt/data/skills/<skill-name>/`** — bind-mounted into the
   `hermes-agent-ekko` container as the runtime skills directory. This is
   what Hermes actually reads at chat time. Deploy with `scp -r` after
   merging changes here.

2. **`silva-1337/ekko` repo** — mirrored so the Ekko Docker image rebuilds
   bake the skill into `/app/skills/<skill-name>/`. Without the mirror,
   any image rebuild on Hostinger wipes the VPS skill until the operator
   re-runs the `scp` step. The mirror is a separate follow-up commit after
   each PR here lands; the per-skill README documents it.

This dual-surface model is intentional: the bind-mount lets us iterate on
skills without rebuilding the Hermes container, and the in-image copy
keeps the system resilient to Hostinger's automated rebuilds.

## Adding a new skill here

1. Create `ekko-skills/<skill-name>/` with at minimum `SKILL.md` and a
   `README.md` documenting deploy.
2. If the skill ships Python code, add `tests/` and ensure tests run with
   `pytest` against a local venv (do not commit the venv; depend only on
   `httpx` + stdlib if you can).
3. Reference the relevant `db/migrations/*.sql` for any table columns the
   skill writes — do not hand-roll schema knowledge that contradicts the
   migrations.
4. Open the PR against this repo first; mirror to `silva-1337/ekko` after
   it lands.

## Required env vars (most skills here)

Skills that write to Supabase pull credentials from the container env:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (service-role so writes bypass RLS)

Set these in `/docker/hermes-agent-t4k4/.env` on the VPS. Each per-skill
README repeats the list relevant to that skill.
