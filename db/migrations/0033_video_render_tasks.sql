-- 0033_video_render_tasks.sql
-- ----------------------------------------------------------------------------
-- Persist in-flight kie.ai VIDEO render task ids so a worker restart can no
-- longer lose (but still bill for) a render (E5.2 / #514).
--
-- THE BUG: the live broll-search path submits a kie video render and BLOCKS on
-- a 10-minute poll (services.kie_video.generate_video). The submitted taskId is
-- never persisted, so a restart mid-poll abandons the render: kie still produces
-- (and bills) the clip, but nothing ever downloads or records it. There was also
-- no route to consume kie's completion callback.
--
-- This table is the durable record of every submitted render. The callback
-- receiver (routes.video_callback) and the periodic reconciliation sweep
-- (services.scheduler.run_kie_reconcile_once) both resolve a render through it,
-- keyed on the kie ``task_id`` (unique) so a duplicate / replayed callback and a
-- reconciliation that races the callback are both idempotent no-ops.
--
-- Forward-only + additive (create ... if not exists), safe to re-apply. RLS
-- deny-all to match every other worker-owned table.
-- ----------------------------------------------------------------------------

create table if not exists video_render_tasks (
  id           uuid primary key default gen_random_uuid(),
  -- The kie.ai task id. Unique so the callback + the sweep are idempotent: the
  -- second writer to resolve a task_id finds it already terminal and no-ops.
  task_id      text not null unique,
  -- Which Veo / unified surface the render used (drives record-info polling).
  is_veo       boolean not null default false,
  -- Lineage back to the creative + brief the render belongs to, so a resolved
  -- clip can be stored against the right segment. Nullable: the sweep can still
  -- resolve + record a clip into the pool even if lineage is thin.
  creative_id  uuid references video_creatives (id) on delete set null,
  brief_id     uuid references video_briefs (id) on delete set null,
  segment_idx  int,
  prompt       text,
  theme        text,
  -- submitted  -> render is in flight (the sweep + callback look for these).
  -- completed  -> result downloaded + stored (terminal; clip_id/result_url set).
  -- failed     -> kie reported a terminal failure (terminal; never re-polled).
  status       text not null default 'submitted'
                 check (status in ('submitted', 'completed', 'failed')),
  result_url   text,
  clip_id      text,
  error        text,
  attempts     int not null default 0,
  submitted_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at   timestamptz not null default now()
);

-- The sweep reads only the still-open renders; partial index keeps it cheap.
create index if not exists video_render_tasks_open_idx
  on video_render_tasks (submitted_at)
  where status = 'submitted';
create index if not exists video_render_tasks_creative_idx
  on video_render_tasks (creative_id) where creative_id is not null;

create trigger video_render_tasks_set_updated_at
  before update on video_render_tasks for each row execute function set_updated_at();

-- RLS deny-all: worker-owned via the service role, never touched by anon.
alter table video_render_tasks enable row level security;
