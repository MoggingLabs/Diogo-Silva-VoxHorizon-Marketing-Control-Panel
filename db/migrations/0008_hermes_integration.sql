-- ============================================================================
-- 0008_hermes_integration.sql
-- ----------------------------------------------------------------------------
-- Hermes integration: kanban mirror + operator approval queue + per-session
-- approval policy cache, plus a `source` column on `pipeline_events` so the
-- UI can tell worker-emitted events apart from Hermes-emitted ones.
--
-- Issue: #257 (HI-15) — Hermes integration migration
--
-- Hermes is the external orchestrator that drives long-running agent
-- workflows. It exposes:
--
--   * A kanban API (`hermes_tasks` mirrors a slice of that board so the
--     dashboard can render the operator's view without round-tripping the
--     Hermes service on every poll).
--   * A pre-tool-call hook (Ekko/Hermes) that asks the operator to approve
--     risky tool invocations before the agent fires them. Each pending
--     approval lands in `approvals`; the operator's decision flows back
--     to the Hermes hook over Realtime.
--   * An "approve and remember" toggle on the decision UI that caches the
--     decision inside the current Ekko session so identical follow-up calls
--     don't re-prompt. That cache lives in `approvals_policy_cache`.
--
-- Source-of-truth notes:
--   * `approvals.id` is uuid but NOT defaulted — the Hermes plugin generates
--     it deterministically from `ekko_tool_call_id` so retries idempotently
--     hit the same row. Inserts must always supply `id`.
--   * `hermes_tasks.kanban_task_id` is the Hermes-side primary key (text).
--     We keep our own uuid `id` so internal FKs / Realtime work the same as
--     every other table, and we UNIQUE-constrain the kanban id.
--   * `pipeline_events.source` defaults to `'worker'` so existing inserts
--     (and the entire historical timeline) stay valid. New emitters set it
--     explicitly.
--
-- RLS stays OFF (single-operator app behind Tailscale).
--
-- Forward-only: never edit a merged migration. New refinements go into a
-- new numbered file.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. hermes_tasks — kanban mirror
-- ---------------------------------------------------------------------------
-- One row per Hermes kanban task that's relevant to the Control Panel
-- dashboard. Status enum mirrors the Hermes kanban lanes; the partial
-- index supports the most common "show me everything still in flight"
-- query without scanning closed work.

create type hermes_task_status_enum as enum (
  'pending',
  'ready',
  'claimed',
  'running',
  'completed',
  'failed',
  'blocked',
  'cancelled'
);

create table hermes_tasks (
  id uuid primary key default gen_random_uuid(),
  kanban_task_id text unique not null,
  pipeline_id uuid references pipelines(id) on delete set null,
  status hermes_task_status_enum not null default 'pending',
  assignee text not null,
  context jsonb not null default '{}'::jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index hermes_tasks_active_idx
  on hermes_tasks(status)
  where status not in ('completed', 'cancelled');

create index hermes_tasks_pipeline_idx on hermes_tasks(pipeline_id);

-- ---------------------------------------------------------------------------
-- 2. approvals — operator decision queue
-- ---------------------------------------------------------------------------
-- One row per pending / decided pre-tool-call approval request from the
-- Hermes/Ekko hook. The Hermes plugin computes `id` deterministically from
-- `ekko_tool_call_id` (so retries are idempotent) — that's why this column
-- is NOT defaulted. Realtime UPDATEs on this table drive the operator UI's
-- decision banner.

create type approval_decision_enum as enum (
  'approved',
  'rejected',
  'approved_with_caveat'
);

create type approval_status_enum as enum (
  'pending',
  'decided',
  'expired',
  'cancelled'
);

create table approvals (
  id uuid primary key,
  ekko_session_id text not null,
  ekko_tool_call_id text not null,
  tool_name text not null,
  tool_args jsonb not null,
  risk_class text,
  context jsonb,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status approval_status_enum not null default 'pending',
  decision approval_decision_enum,
  decided_by text,
  decided_at timestamptz,
  decision_notes text,
  cache_for_session boolean default false,
  cache_for_minutes int,
  worker_received_at timestamptz
);

-- Partial index: the operator UI almost exclusively queries "pending,
-- newest first". Keeping the index partial keeps it small and writes cheap.
create index approvals_pending_idx
  on approvals(requested_at desc)
  where status = 'pending';

-- Per-session timeline for the "what did I just decide?" replay view.
create index approvals_session_idx
  on approvals(ekko_session_id, requested_at desc);

-- ---------------------------------------------------------------------------
-- 3. approvals_policy_cache — per-session "approve and remember" cache
-- ---------------------------------------------------------------------------
-- When the operator decides on an approval with `cache_for_session = true`,
-- the worker writes a row here so identical follow-up tool calls (same
-- session, same tool, same args hash) skip the prompt. The Hermes plugin
-- consults this table before opening a new approval row.
--
-- `tool_args_hash` is a SHA-256 hex digest computed in the app layer over
-- the canonicalised args JSON — we don't hash inside Postgres so the
-- canonicalisation lives next to the rest of the policy logic.

create table approvals_policy_cache (
  id uuid primary key default gen_random_uuid(),
  ekko_session_id text not null,
  tool_name text not null,
  tool_args_hash text not null,
  decision approval_decision_enum not null,
  cached_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Lookup index — the Hermes plugin probes this exact tuple per tool call.
-- We can't use a `where expires_at > now()` predicate on the index because
-- `now()` isn't IMMUTABLE (Postgres rejects mutable functions in index
-- predicates). Instead the index covers all rows and the app filters on
-- `expires_at > now()` at query time; a periodic delete sweeps expired
-- entries so the index stays bounded.
create index approvals_policy_cache_lookup_idx
  on approvals_policy_cache(ekko_session_id, tool_name, tool_args_hash);

create index approvals_policy_cache_expires_idx
  on approvals_policy_cache(expires_at);

-- ---------------------------------------------------------------------------
-- 4. pipeline_events.source — emitter discriminator
-- ---------------------------------------------------------------------------
-- The Hermes hook and Hermes tasks both emit `pipeline_events` rows. We
-- add a `source` column so the UI (and any debugging tool) can tell them
-- apart from the worker's own emissions. Default `'worker'` keeps every
-- historical row valid and lets existing emitters stay unchanged.

create type pipeline_event_source_enum as enum (
  'worker',
  'hermes-hook',
  'hermes-task',
  'manual'
);

alter table pipeline_events
  add column source pipeline_event_source_enum not null default 'worker';

-- ---------------------------------------------------------------------------
-- 5. Realtime publication
-- ---------------------------------------------------------------------------
-- All three new tables drive operator UI in realtime:
--   * `hermes_tasks` — kanban board refresh.
--   * `approvals` — decision banner / queue.
--   * `approvals_policy_cache` — "remembered decisions" panel.

alter publication supabase_realtime
  add table hermes_tasks, approvals, approvals_policy_cache;
