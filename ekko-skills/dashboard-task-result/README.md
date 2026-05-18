# `dashboard-task-result` — operator deploy notes

This skill ships in our repo but Hermes runs on the VPS, so the helper code
needs to be made available inside the Hermes container before any kanban task
can call it. This README is the operator-facing checklist for that one-time
deploy.

## Layout

```
ekko-skills/dashboard-task-result/
├── SKILL.md           # Anthropic-format skill manifest (front-matter + body)
├── helper.py          # publish_task_result() — the only public function
├── README.md          # this file
└── tests/
    └── test_helper.py # pytest unit tests (mock httpx)
```

## Deploy procedure

The Hermes container bind-mounts `/opt/data/skills/` from the VPS host as its
skills directory. Anything we put inside `/opt/data/skills/<skill-name>/` is
discoverable by Hermes after a container restart.

1. SSH into the VPS as `root` (or the deploy user with sudo).

2. Pull the latest dashboard repo onto the host (if not already):

   ```bash
   cd /opt/dashboard-repo
   git pull --ff-only
   ```

3. Sync the skill into Hermes' skills directory:

   ```bash
   sudo rsync -a --delete \
     /opt/dashboard-repo/ekko-skills/dashboard-task-result/ \
     /opt/data/skills/dashboard-task-result/
   ```

   `--delete` keeps the deployed copy a faithful mirror of the repo, so a
   removed file in the repo is also removed on the VPS.

4. Confirm the Hermes container has the two env vars set in
   `/opt/data/.env` (already done for sibling skills HI-9 / HI-10):

   ```
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service-role JWT>
   ```

5. Restart Hermes so it picks up the new skill manifest:

   ```bash
   docker restart hermes-agent-ekko
   ```

6. Validate Hermes loaded the skill without front-matter / discovery errors:

   ```bash
   docker exec hermes-agent-ekko hermes skills list | grep dashboard-task-result
   ```

   You should see a line with `dashboard-task-result` and no warnings.

## Smoke test

After deploy, fire a one-shot Hermes invocation that exercises the helper:

```bash
docker exec hermes-agent-ekko python3 -c "
import sys
sys.path.insert(0, '/opt/data/skills/dashboard-task-result')
from helper import publish_task_result

out = publish_task_result(
    kanban_task_id='<an existing test kanban_task_id from the dashboard>',
    pipeline_id=None,
    result={'smoke': True, 'note': 'deploy validation'},
    success=True,
)
print('OK', out['task']['id'], out['event']['id'])
"
```

Confirm two things:

- The command prints `OK <task-uuid> <event-uuid>` with no exception.
- The dashboard's pipeline timeline pane shows a new `task_completed` row
  with `source='hermes-task'` within ~1s (Supabase Realtime).

If the helper raises `DashboardTaskResultError`, read the message — it
carries the Supabase response body and is almost always self-explanatory
(missing env var, 0-row update, schema mismatch).

## Local test suite

```bash
cd ekko-skills/dashboard-task-result
pytest tests/test_helper.py -v
```

The tests mock `httpx.Client` so no Supabase credentials are required.

## Pairs with

- `infra/hermes/config.yaml.patch` — the shell-hook patch that fires
  fire-and-forget `post_tool_call` / `on_session_end` events into the worker
  webhook. The hooks are observability; this skill is the canonical task
  lifecycle write. Both ship together (HI-11).
