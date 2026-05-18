# dashboard-chat-publish

Ekko skill — appends a row to the dashboard's `chat_messages` Supabase
table after every assistant turn that runs inside a dashboard chat
session, so the side-panel chat log survives the SSE stream closing.

## Why

The chat SSE proxy (HI-1 / HI-2, `worker/src/routes/hermes_chat.py`)
streams assistant tokens directly from `hermes chat` to the browser.
Once the browser disconnects (page reload, tab close, route change),
the stream is the only record of the turn. The dashboard side panel
needs a persistent log so subsequent mounts re-render the conversation.

This skill writes that single source-of-truth row to `chat_messages`,
which is the same table the dashboard's realtime subscription listens
on (see `db/migrations/0005_chat_messages.sql` and `lib/chat-context.ts`).

## Install

This skill is loaded by Hermes (the agent runtime) as part of the
`hermes-agent-ekko` container. Two install paths:

### 1. Local Hermes (developer machine)

```bash
# From the repo root.
hermes skills install ekko-skills/dashboard-chat-publish
hermes skills list  # dashboard-chat-publish should appear
```

### 2. Containerised Hermes (production)

The `hermes-agent-ekko` container mounts `ekko-skills/` read-only at
`/app/skills/`. Restart the container after pulling new commits:

```bash
docker compose -f infra/docker-compose.yml restart hermes-agent-ekko
```

Hermes auto-discovers any directory under the mount that contains a
`SKILL.md` with valid frontmatter.

## Environment

The helper talks to Supabase over PostgREST and requires:

| Var                   | Source                                   |
| --------------------- | ---------------------------------------- |
| `SUPABASE_URL`        | repo `.env`, already used by the worker. |
| `SUPABASE_SECRET_KEY` | repo `.env`, already used by the worker. |

Both come from the worker's existing `.env`; no new secrets are
introduced. If either is unset the helper raises `RuntimeError` on
first call (loud-fail, same shape as
`worker/src/supabase_client.get_supabase_admin`).

## Usage

```python
from helper import publish_message

row = publish_message(
    thread_id="video:7b2c1d0e-1234-4abc-9def-0123456789ab",
    role="assistant",
    content="I rewrote segment 2's voiceover for more punch.",
)
print(row["id"], row["created_at"])
```

With tool calls:

```python
publish_message(
    thread_id="image:11111111-2222-3333-4444-555555555555",
    role="assistant",
    content="Generating two ratio variants.",
    tool_calls=[
        {"name": "image_ad_prompting", "input": {"ratio": "9x16"}},
        {"name": "image_ad_prompting", "input": {"ratio": "1x1"}},
    ],
)
```

See `SKILL.md` for the canonical trigger pattern and hard rules.

## Tests

```bash
cd ekko-skills/dashboard-chat-publish
pytest tests/test_helper.py -v
```

The suite mocks `httpx.post` so it runs offline; no Supabase access
required.

## Schema

See `db/migrations/0005_chat_messages.sql` — that file is the source
of truth. Relevant columns this skill writes:

| Column          | Value                                               |
| --------------- | --------------------------------------------------- |
| `creative_type` | Parsed from `thread_id` prefix (`image` / `video`). |
| `creative_id`   | Parsed from `thread_id` suffix (uuid).              |
| `author`        | `user` / `ekko` / `system` (mapped from `role`).    |
| `content_type`  | `tool_call` if `tool_calls` is given, else `text`.  |
| `content`       | The rendered text the dashboard renders.            |
| `metadata`      | `{"tool_calls": [...]}` when applicable, else `{}`. |

Columns `id`, `created_at`, `updated_at`, `is_edited` default in the
database; the skill never sets them.
