---
name: dashboard-task-result
description: |
  Publish the final output of a Hermes kanban task to the VoxHorizon
  dashboard. Use this at the END of every kanban task execution (Ekko's
  worker pattern) — it writes the result JSON to `hermes_tasks.result`,
  flips the row's `status` to `completed` or `failed`, and emits a
  paired `pipeline_events` timeline row with `source='hermes-task'`.
  Trigger phrases: "publish task result to dashboard",
  "mark kanban task completed", "record hermes task output",
  "task finished, write result to supabase",
  "emit task_completed event", "emit task_failed event".
---

# dashboard-task-result

A thin Python wrapper that closes out a kanban task on the dashboard side.
Hermes' kanban executor calls this once per task, after the skill body has
produced its final output (or aborted with an error).

The helper performs two writes:

1. `PATCH /rest/v1/hermes_tasks?kanban_task_id=eq.<id>` — sets `result` jsonb
   and `status = 'completed' / 'failed'`.
2. `POST /rest/v1/pipeline_events` — emits a timeline row with
   `source='hermes-task'` and `kind='task_completed' / 'task_failed'` so the
   dashboard's timeline pane reflects the lifecycle transition without
   polling.

Both writes use the Supabase service-role key (bypasses RLS).

## When to use

- At the end of every kanban task execution. Always. Even on failure — the
  dashboard renders a stale "running" row indefinitely if you skip this.
- After the skill body has produced its final JSON output. Pass that JSON
  through unchanged as `result`.
- When you need to flip a task from `running` → `completed` / `failed`. Do
  NOT use this for intermediate progress updates (no `running` writes —
  status is set elsewhere when the task is claimed).

If you only need to update the status (no result payload yet) this is the
wrong tool; update `hermes_tasks` directly through the kanban bridge.

## Where the helper lives

The deployed location is `/opt/data/skills/dashboard-task-result/helper.py`
(the VPS bind-mounts `/opt/data/skills/` into the Hermes container as the
skills directory). The repository copy lives at
`ekko-skills/dashboard-task-result/helper.py` and must be deployed to the
VPS for Hermes to find it — see this skill's `README.md` for the deploy
procedure.

## Example: terminal-tool invocation

```
python3 -c "
import sys
sys.path.insert(0, '/opt/data/skills/dashboard-task-result')
from helper import publish_task_result

result = publish_task_result(
    kanban_task_id='hermes-2026-05-17-001',
    pipeline_id='8a1f2c3d-4e5f-6789-abcd-ef0123456789',
    result={
        'video_url': 'https://supabase.../creative-001.mp4',
        'duration_s': 28.5,
        'segments': 4,
    },
    success=True,
)
print('updated task', result['task']['id'])
print('emitted event', result['event']['id'])
"
```

The helper opens an HTTP client only inside the function call, so importing
the module is cheap (no environment access at import time).

## Required environment variables

Set in `/opt/data/.env` (loaded by the Hermes container at start):

- `SUPABASE_URL` — e.g. `https://<project-ref>.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — service-role JWT (bypasses RLS for writes)

Both are read lazily on the first call. Missing/empty values raise
`DashboardTaskResultError` immediately so misconfiguration is obvious.

## Function

### `publish_task_result`

```
publish_task_result(
    *,
    kanban_task_id: str,
    pipeline_id: str | None,
    result: dict,
    success: bool,
) -> dict
```

Closes out a kanban task. Keyword-only arguments. Returns
`{"task": <hermes_tasks row>, "event": <pipeline_events row>}`.

- `kanban_task_id` — the Hermes-side primary key of the kanban task. UNIQUE
  on `hermes_tasks.kanban_task_id`. Required.
- `pipeline_id` — the dashboard pipeline this task feeds, or `None` when
  the task isn't pipeline-scoped (e.g. ad-hoc operator request).
  `pipeline_events.pipeline_id` is nullable for hook / task rows.
- `result` — the skill's final output payload. Stored verbatim in
  `hermes_tasks.result` jsonb and mirrored into the timeline event's
  `payload`.
- `success` — `True` for `completed` / `task_completed` transitions,
  `False` for `failed` / `task_failed`.

The function does NOT swallow exceptions — Hermes' worker pattern owns
retry / error-surfacing logic. Bubble failures up so they're visible.

## Errors

- Network failure (httpx transport error, timeout) → raises
  `DashboardTaskResultError` wrapping the original exception. Caller should
  retry once.
- Supabase HTTP 5xx → raises `DashboardTaskResultError` with the status
  code and response body. Treat as transient; retry once.
- Supabase HTTP 4xx (schema mismatch, RLS denial, enum mismatch) → raises
  `DashboardTaskResultError` with the response body. Do NOT retry; fix
  the caller's payload.
- 0-row update (no `hermes_tasks` row matches `kanban_task_id`) → raises
  `DashboardTaskResultError`. This means the kanban mirror is out of sync;
  do not retry silently.
- Missing env vars → raises `DashboardTaskResultError` immediately.

```python
from helper import publish_task_result, DashboardTaskResultError

try:
    out = publish_task_result(
        kanban_task_id='hermes-2026-05-17-001',
        pipeline_id=None,
        result={'error': 'kie_generate timeout'},
        success=False,
    )
except DashboardTaskResultError as exc:
    # log and decide: retry once for 5xx/network, otherwise surface to operator
    print(f'publish failed: {exc}')
```

## Related

- Sibling skill `dashboard-publish` (HI-9): publishes briefs / creatives /
  audit rows / pipeline events for skills that produce artifacts.
- Sibling skill `dashboard-chat-publish` (HI-10): publishes chat-stream
  output back to the dashboard for the Ekko chat surface.
- Hermes hooks config patch (`infra/hermes/config.yaml.patch`): pairs with
  this skill — the hooks fire-and-forget post-tool-call observability into
  the worker webhook; this skill writes the canonical task lifecycle state.
