-- ============================================================================
-- 0005_chat_messages.sql
-- ----------------------------------------------------------------------------
-- chat_messages — persistent chat history shared between operator and Ekko.
--
-- Issue: #143 (Wave 5.5-1) — chat_messages table + migration
--
-- Polymorphic FK: a single chat thread is keyed by
-- (creative_type, creative_id). The target table is `creatives` for
-- `creative_type = 'image'` and `video_creatives` for `creative_type = 'video'`.
-- We intentionally do NOT install a DB-level foreign key on `creative_id`
-- because Postgres has no native polymorphic FK; the application layer
-- enforces existence. A future migration can add per-format constraint
-- triggers if drift becomes a problem.
--
-- `metadata` is a flexible jsonb bag for things that don't justify a
-- dedicated column yet (tool input, tool result payload, attachment URLs,
-- model id, latency, etc.). Schema for individual entries is owned by the
-- worker + the chat-context translation layer (`lib/chat-context.ts`).
--
-- `reply_to_id` is a self-reference for threading; null for top-level
-- messages. Tool results that follow a tool call set `reply_to_id` to the
-- assistant message that emitted the call so the UI can group them.
--
-- Forward-only: never edit a merged migration. New refinements go into a
-- new numbered file.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

create type chat_author as enum ('user', 'ekko', 'system');

create type chat_content_type as enum ('text', 'tool_call', 'tool_result', 'system');

create type chat_creative_type as enum ('image', 'video');

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table chat_messages (
  id              uuid primary key default gen_random_uuid(),
  creative_type   chat_creative_type not null,
  creative_id     uuid not null,
  author          chat_author not null,
  content_type    chat_content_type not null default 'text',
  content         text,
  metadata        jsonb default '{}'::jsonb,
  tool_call_id    text,
  reply_to_id     uuid references chat_messages(id),
  is_edited       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Primary thread lookup: load the conversation for one creative in order.
create index on chat_messages (creative_type, creative_id, created_at);

-- Global recency index used by ops dashboards / audit feeds.
create index on chat_messages (created_at desc);

-- ---------------------------------------------------------------------------
-- Realtime publication
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table chat_messages;
