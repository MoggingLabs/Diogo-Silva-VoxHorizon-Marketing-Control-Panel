---
name: dashboard-publish
description: |
  Publish a structured artifact row to the VoxHorizon dashboard's Supabase
  tables. Use this when a skill produces a brief, creative, audit row, or
  pipeline event that should appear in the dashboard UI. Trigger phrases:
  "publish a brief row", "save creative to dashboard",
  "write audit result to supabase", "emit pipeline event to dashboard",
  "save brief to dashboard", "publish ad creative to supabase",
  "log pipeline event".
---

# dashboard-publish

A thin Python wrapper over the VoxHorizon dashboard's Supabase REST API. Every
function does a single INSERT and returns the inserted row. Authentication
uses the service-role key so writes bypass RLS.

## When to use

- After `campaign-brief` produces a draft → call `publish_brief(...)`
- After `image-ad-prompting` produces a creative → call `publish_creative(...)`
- After `campaign-audit` produces a verdict → call `publish_audit_row(...)`
- After any skill emits a pipeline-relevant event → call `publish_pipeline_event(...)`

If the dashboard UI should render the artifact within ~1s of the skill
finishing, you need to publish through this helper — the dashboard does not
poll Hermes' workspace.

## Where the helper lives

The deployed location is `/opt/data/skills/dashboard-publish/helper.py` (the
VPS bind-mounts `/opt/data/skills/` into the Hermes container as the skills
directory). The repository copy lives at
`ekko-skills/dashboard-publish/helper.py` and must be deployed to the VPS for
Hermes to find it — see this skill's `README.md` for the deploy procedure.

## Example: terminal-tool invocation

```
python3 -c "
import sys
sys.path.insert(0, '/opt/data/skills/dashboard-publish')
from helper import publish_brief

row = publish_brief(
    client_slug='dinerohomes',
    payload={
        'service': 'roofing',
        'budget': 50,
        'market': 'Austin',
        'angles': ['price-shock', 'real-person'],
        'cta': 'free estimate',
    },
    status='posted',
)
print('inserted brief', row['id'])
"
```

The helper opens an HTTP client only inside the function call, so importing
the module is cheap (no environment access at import time).

## Required environment variables

Set in `/opt/data/.env` (loaded by the Hermes container at start):

- `SUPABASE_URL` — e.g. `https://<project-ref>.supabase.co`
- `SUPABASE_SECRET_KEY` — service-role JWT (bypasses RLS for writes)

Both are read lazily on the first call. Missing/empty values raise
`DashboardPublishError` immediately so misconfiguration is obvious.

## Functions

All functions take keyword-only arguments and return the inserted Supabase
row as a `dict`.

### `publish_brief`

```
publish_brief(
    *,
    client_slug: str,
    payload: dict,
    status: str = 'draft',
    brief_id: str | None = None,
    brief_id_human: str | None = None,
) -> dict
```

Inserts a row into `public.briefs`. `payload` must contain at least
`service` and `budget` (the schema's CHECK constraint). `status` is a
`brief_status` enum value: `draft | posted | approved | approved_with_changes
| rejected`. If `brief_id_human` is omitted the caller should pre-generate
one via the `gen_brief_id_human` Postgres function (it is NOT NULL in the
schema).

### `publish_creative`

```
publish_creative(
    *,
    brief_id: str,
    concept: str,
    ratio: str,
    file_path_supabase: str,
    prompt_used: dict,
    version: str = 'v1.0',
    status: str = 'draft',
    offer_text: str | None = None,
) -> dict
```

Inserts a row into `public.creatives` (image side). `ratio` is one of
`1x1 | 9x16 | 16x9`. `status` is a `image_creative_status` enum value:
`draft | approved | rejected | live | killed`.

### `publish_audit_row`

```
publish_audit_row(
    *,
    client_id: str,
    campaign_id: str,
    window_days: int,
    metrics: dict,
    verdict: str,
    verdict_reason: str | None = None,
    format: str = 'image',
) -> dict
```

Inserts a row into `public.campaign_perf_image` (default) or
`public.campaign_perf_video` depending on `format`. `metrics` is unpacked
into the table's typed columns (`spend`, `impressions`, `clicks`, `ctr`,
`leads_meta`, `leads_ghl`, `cpl_real`, `freq`, plus video-only `hook_rate`,
`drop_off_3s`, `view_rate_avg`, `watch_time_p50`). Unknown keys are dropped
silently so callers can pass through extra fields.

### `publish_pipeline_event`

```
publish_pipeline_event(
    *,
    pipeline_id: str,
    kind: str,
    stage: str | None = None,
    payload: dict | None = None,
    source: str = 'hermes-task',
) -> dict
```

Inserts a row into `public.pipeline_events`. `source` defaults to
`hermes-task` per the `pipeline_event_source_enum` values (`worker |
hermes-hook | hermes-task | manual`).

## Errors

- Network failure (httpx transport error, timeout) → raises
  `DashboardPublishError` wrapping the original exception. Caller should
  retry once.
- Supabase HTTP 5xx → raises `DashboardPublishError` with the status code
  and response body. Treat as transient; retry once.
- Supabase HTTP 4xx (schema mismatch, RLS denial, enum mismatch) → raises
  `DashboardPublishError` with the response body. Do NOT retry; fix the
  caller's payload.
- Missing env vars → raises `DashboardPublishError` immediately.

```python
from helper import publish_brief, DashboardPublishError

try:
    row = publish_brief(client_slug='dinerohomes', payload={...})
except DashboardPublishError as exc:
    # log and decide: retry once for 5xx/network, otherwise surface to operator
    print(f'publish failed: {exc}')
```
