-- 0058_monitor_action_result.sql
-- ----------------------------------------------------------------------------
-- Monitor connector: audit the EXECUTED kill/scale action on Meta.
--
-- THE GAP. The monitor stage's kill/scale verdict was a no-op: the
-- monitor/decision route enqueued a `worker_monitor` work_item whose handler
-- only logged + acknowledged, so a manager's "kill" never paused the live Meta
-- campaign and a "scale" never changed spend. The fix follows the LAUNCH
-- pattern (Meta is operator-held MCP; the worker has no Meta credentials): the
-- monitor/decision route now enqueues an `operator_dispatch(monitor_action)`,
-- the operator EXECUTES the change on Meta via `ads_update_entity`
-- (kill -> status PAUSED; scale -> raise daily_budget), and records the
-- executed outcome HERE via the worker recorder
-- (`/work/pipeline/tools/monitor_action_result`).
--
-- WHY A NEW TABLE (not campaign_perf_image / campaign_perf_video). Those
-- existing tables record the monitor READ -- the KPI snapshot (spend, leads,
-- cpl_real) plus the recommend-phase kill/watch/keep/scale verdict. This table
-- records a different concern: the EXECUTED post-approval action on Meta (the
-- audited who/what/when, the new budget for a scale, the pause for a kill, and
-- the Meta entity it was applied to). Keeping the executed-action audit
-- separate from the performance read avoids overloading a daily-KPI row with an
-- imperative side-effect record and keeps each table single-purpose.
--
-- ad_entity already carries the campaign's live `meta_id` (kind='campaign'),
-- keyed by pipeline_id (migration 0022); the recorder links each action row to
-- the recorded ad_entity so the audit trail joins back to the launched graph.
-- Forward-only.
-- ----------------------------------------------------------------------------

-- The executed monitor verdict the operator applied on Meta.
create type monitor_action_kind_enum as enum ('kill', 'scale');

create table monitor_action_result (
  id            uuid primary key default gen_random_uuid(),
  pipeline_id   uuid not null references pipelines (id) on delete cascade,
  ad_entity_id  uuid references ad_entity (id) on delete set null,
  client_id     uuid references clients (id),
  -- The Meta campaign the action was applied to (the operator looked this up
  -- from ad_entity.meta_id, kind='campaign'). Free text: it is a Meta id, not a
  -- local FK.
  campaign_id   text,
  decision      monitor_action_kind_enum not null,         -- kill | scale
  -- The new daily budget (minor currency units, e.g. cents) a `scale` wrote to
  -- Meta. Null for a `kill` (a pause carries no budget change).
  target_budget numeric,
  -- Who approved the verdict (the manager); the operator executed it.
  approved_by   text,
  notes         text,
  -- The Meta MCP `ads_update_entity` echo / evidence the operator captured.
  meta_payload  jsonb,
  executed_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index monitor_action_result_pipeline_idx on monitor_action_result (pipeline_id);
create index monitor_action_result_campaign_idx on monitor_action_result (campaign_id);

-- RLS deny-all (service-role worker writes; no anon/authenticated access).
alter table monitor_action_result enable row level security;

-- Dashboard surfaces the executed kill/scale on the pipeline timeline.
alter publication supabase_realtime add table monitor_action_result;
