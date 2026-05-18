---
name: dashboard-chat-publish
description: |
  Append a chat-message row to the dashboard's chat_messages Supabase table.
  Use this AFTER every assistant turn during a dashboard-driven chat session
  so the side-panel chat log persists between page reloads. Trigger phrases:
  "publish chat reply", "save assistant message to dashboard",
  "append to chat_messages".
---

# Dashboard Chat Publish

This skill exists for one reason: Ekko's chat replies during an active
dashboard chat session need to appear in the side-panel chat log even
AFTER the SSE stream ended. Today the SSE stream is the only record —
once the browser disconnects (page reload, tab close, route change) the
operator loses the turn.

Each assistant turn that runs inside a dashboard chat session calls
`publish_message(...)` once, immediately after the turn finishes, so the
row lands in `chat_messages` and the dashboard renders it the next time
the side panel mounts.

## When to use

- Right after Ekko emits its final assistant message during a chat turn
  driven by the dashboard's `/work/hermes/chat` SSE proxy (see HI-1/HI-2).
- After any tool-result message that the operator should see persisted
  (e.g. "I attached a new b-roll clip" — the human-readable summary).
- When the operator says "publish chat reply", "save assistant message
  to dashboard", or "append to chat_messages".

Do NOT use this skill for:

- The operator's own messages — the Next.js side panel writes those
  directly to Supabase before the SSE call lands.
- Raw tool-call envelopes that the dashboard doesn't render. The skill
  accepts a `tool_calls` payload but treats it as metadata, not as the
  rendered content.
- Hermes runs that do NOT originate from a dashboard chat session
  (cron-driven pipelines, webhook handlers). Those have their own
  iteration tables (`creative_iterations`, `video_iterations`).

## Trigger pattern

The intended orchestration, owned by Hermes' chat loop, is:

1. Operator hits the chat side-panel and sends a message.
2. Next.js inserts that user message into `chat_messages` and opens the
   `/work/hermes/chat` SSE stream.
3. Worker runs `hermes chat` inside the `hermes-agent-ekko` container.
4. Ekko receives the SSE prompt, calls whichever skills it needs to
   answer (image-ad-prompting, video-voiceover-broll, etc.).
5. **After Ekko emits its final reply, it MUST call this skill with the
   assembled `content`.** The skill writes a single row with
   `author='ekko'` so the dashboard's realtime subscription picks it up.
6. Worker closes the SSE stream. Browser disconnects whenever it wants;
   the conversation is now persistent.

A future wrapping skill ("dashboard-chat-orchestrator") may bundle
steps 4-5 so individual skills never need to know about persistence.
For now this skill is the explicit publish boundary.

## Inputs

`publish_message(thread_id, role, content, tool_calls=None) -> dict`.

| Argument     | Type          | Required | Notes                                                                                                                                                                                                                                              |
| ------------ | ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread_id`  | `str`         | yes      | The dashboard chat thread. Format: `"<creative_type>:<creative_id>"`, e.g. `"video:7b2c1d0e-..."` or `"image:..."`. This matches the polymorphic thread key documented in migration `0005_chat_messages.sql` (`creative_type` + `creative_id`).    |
| `role`       | `str`         | yes      | One of `"user"`, `"assistant"`, `"system"`. The skill maps `"assistant"` → DB enum value `"ekko"`; the other two pass through. Anything else raises `ValueError` so the caller fails loudly rather than silently writing junk.                     |
| `content`    | `str`         | yes      | The rendered text the dashboard should display. Empty string is allowed (e.g. when the entire response is a tool call) but `None` raises.                                                                                                          |
| `tool_calls` | `list / None` | no       | Optional. When provided, the skill writes `content_type='tool_call'` and stuffs the list under `metadata.tool_calls`. When omitted/`None`, `content_type='text'` and `metadata` stays `{}`. Pass a JSON-serialisable list — dicts inside are fine. |

## Outputs

Returns the inserted row as a `dict` with at least `id`, `creative_type`,
`creative_id`, `author`, `content_type`, `content`, `created_at`. The
caller should not assume any specific extra keys; Supabase returns
whatever the column set is on the day.

On error the skill raises:

- `ValueError` for bad inputs (unknown role, malformed thread_id, None
  content).
- `RuntimeError` when `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` are
  unset — the same loud-fail behaviour as `get_supabase_admin()`.
- `httpx.HTTPStatusError` when Supabase returns a non-2xx. The skill
  does not retry; the caller (Hermes chat loop) decides whether to
  resend or surface the failure to the operator.

## Environment

The skill talks to Supabase over PostgREST (no Python SDK dep — keeps
the skill container thin). Required env vars:

- `SUPABASE_URL` — e.g. `https://abcd1234.supabase.co`.
- `SUPABASE_SERVICE_ROLE_KEY` — the worker's service-role JWT.

Both come from the worker's existing `.env` so no new secrets are
introduced.

## Hard rules

- Exactly one row per `publish_message` call. The skill never batches.
- The skill writes only to `chat_messages`. It never touches
  `creative_iterations`, `video_iterations`, or any other table.
- `author='ekko'` is the assistant-role mapping. `author='user'` is for
  the operator (rare from this skill — the dashboard usually writes
  user rows directly), `author='system'` is for tool-result narration.
- `thread_id` must split cleanly on the first `:`. The prefix must be
  `"image"` or `"video"` (the `chat_creative_type` enum values). The
  suffix is taken as a uuid and forwarded as-is; the skill does not
  validate uuid shape — Supabase will reject malformed values at insert
  time and the resulting HTTPStatusError surfaces to the caller.
- Em dashes are banned in `content` (Ekko house rule). The skill does
  NOT auto-strip them — the caller already ran the response through
  the ad-copy filter; if an em dash leaks in, that is a caller bug to
  fix upstream.

## Self-audit before returning

1. Did the row actually get inserted? (`prefer=return=representation`
   means Supabase echoes the row; if the response body is empty, the
   skill raises.)
2. Did `thread_id` parse into a valid `(creative_type, creative_id)`
   pair?
3. Did `role` map to a real `chat_author` enum value?
4. If `tool_calls` was provided, did `metadata.tool_calls` land in the
   response payload? (Sanity check on PostgREST jsonb round-trip.)

## Related

- `db/migrations/0005_chat_messages.sql` — table + enum definitions.
  Source of truth for the column set this skill writes.
- `lib/chat-context.ts` — the Next.js / worker translation layer that
  reads the same table. If you add columns there, mirror them here.
- Sibling skill `dashboard-publish` (HI-9) — publishes creative-level
  status updates to the dashboard; uses the same env vars but writes
  to a different table.
- HI-1 / HI-2 / `worker/src/routes/hermes_chat.py` — the SSE proxy
  that wraps the chat loop calling this skill.
