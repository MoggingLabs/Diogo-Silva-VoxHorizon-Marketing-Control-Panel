# dashboard-publish (Hermes skill)

Thin Python helper that other Hermes/Ekko skills call to publish artifact
rows into the VoxHorizon dashboard's Supabase tables (`briefs`, `creatives`,
`campaign_perf_image`, `campaign_perf_video`, `pipeline_events`).

The repo copy is the source of truth. The runtime copy lives on the VPS at
`/opt/data/skills/dashboard-publish/` and must be redeployed whenever this
directory changes.

## Files

- `SKILL.md` — Hermes skill manifest (frontmatter + body documenting usage
  and trigger phrases).
- `helper.py` — Python module with the four publish functions:
  `publish_brief`, `publish_creative`, `publish_audit_row`,
  `publish_pipeline_event`. All return the inserted Supabase row.
- `tests/test_helper.py` — pytest suite covering happy paths, schema
  validation, HTTP 4xx/5xx/network errors, and missing env-var
  configuration. Uses `httpx.MockTransport` so no real network IO fires.

## Local tests

The skill has a single non-stdlib runtime dependency (`httpx`) and uses
`pytest` for tests.

```
cd ekko-skills/dashboard-publish
python3 -m venv .venv
.venv/bin/pip install httpx pytest
.venv/bin/pytest tests/ -v
```

`.venv/` is local-only — do not commit it.

## VPS deployment

The skills directory is bind-mounted into the Hermes container, so deploying
is just copying files and restarting. After this PR merges:

1. From a workstation with SSH access to the VPS:

   ```bash
   scp -r ekko-skills/dashboard-publish/ \
     voxhorizon-vps:/docker/hermes-agent-t4k4/data/skills/
   ssh voxhorizon-vps \
     'chown -R 10000:10000 /docker/hermes-agent-t4k4/data/skills/dashboard-publish'
   ```

   (The container runs as uid `10000`; mismatched ownership makes Hermes
   ignore the skill silently.)

2. Add the two env vars to `/docker/hermes-agent-t4k4/.env` if they are not
   already present:

   ```
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service-role-jwt>
   ```

   Service-role key (not anon) — the helper writes rows that bypass RLS.

3. Restart the Hermes container so it reloads the skills index and picks
   up the new env vars:

   ```bash
   ssh voxhorizon-vps 'docker restart hermes-agent-ekko'
   ```

4. Verify the skill is registered:

   ```bash
   ssh voxhorizon-vps 'docker exec hermes-agent-ekko hermes skills list \
     | grep dashboard-publish'
   ```

5. Smoke-test end-to-end from inside the container:
   ```bash
   ssh voxhorizon-vps \
     'docker exec hermes-agent-ekko hermes chat -q \
       "Use dashboard-publish to save a fake brief for client dinerohomes \
        with service roofing and budget 50."'
   ```
   The dashboard's `/briefs` page should render the new row within ~1s
   (Realtime).

## Mirror to the `silva-1337/ekko` repo

The Hermes/Ekko base image rebuilds bake `skills/` into the image so the
operator does not have to redeploy after every container rebuild. Whenever
this skill changes:

1. Copy the directory to a checkout of `silva-1337/ekko`:
   ```
   cp -r ekko-skills/dashboard-publish/ \
     ../ekko/Ekko/skills/dashboard-publish/
   ```
2. Commit + push from the ekko checkout.

That mirror is a follow-up step after this PR lands; it is intentionally
out of scope for this commit so the dashboard repo and the skill registry
can evolve independently in this wave.

## Schema reference

The helper writes into these tables (see `db/migrations/0001_initial_schema.sql`,
`0006_pipelines.sql`, `0008_hermes_integration.sql` in the repo root for the
authoritative column lists):

- `public.briefs` — `payload jsonb` must contain `service` and `budget`.
- `public.creatives` — `ratio` is `1x1 | 9x16 | 16x9`; `status` is one of
  the `image_creative_status` enum values.
- `public.campaign_perf_image` / `public.campaign_perf_video` — daily
  uniqueness on `(client_id, campaign_id, window_days, day(pulled_at))`.
  A duplicate insert on the same day returns HTTP 409.
- `public.pipeline_events` — `source` is `hermes-task` by default (per the
  `pipeline_event_source_enum`).

If a new column is added in a future migration, update `helper.py`'s call
sites (and the corresponding test) — the helper passes through only the
fields it knows about.
