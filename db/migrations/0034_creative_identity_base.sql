-- 0034_creative_identity_base.sql
-- ----------------------------------------------------------------------------
-- M1 (#448) keystone, EXPAND phase (part 1 of 2).
--
-- Introduce a neutral `creative` identity that BOTH verticals share, so the
-- shared gate / evidence / launch / cost tables can foreign-key ONE target
-- (repointed in 0035) instead of `creatives(id)` only. That single-target flaw
-- is why a VIDEO creative (which lives in `video_creatives`) could never own a
-- gate row: the FK rejected it. See docs/adr/0001-neutral-creative-identity.md.
--
-- Strangler-fig: `creatives` and `video_creatives` REMAIN the write surface
-- (their format-specific columns are the de-facto extensions for now). A thin
-- base row mirrors each by id + format. Backfill covers existing rows; AFTER
-- INSERT triggers keep new rows mirrored, so a row written to either table
-- always has a `creative` row before any gate write references it. The contract
-- phase (later) moves writes onto the base and renames the old tables to the
-- explicit `creative_image` / `creative_video` extensions.
--
-- Additive + idempotent (create if not exists / on conflict do nothing).
-- Forward-only.
-- ----------------------------------------------------------------------------

create table if not exists creative (
  id          uuid primary key,                 -- SHARED id space: equals creatives.id / video_creatives.id
  format      creative_type not null,           -- 'image' | 'video'
  client_id   uuid references clients (id),     -- tenant seam (best-effort populated; nullable)
  pipeline_id uuid references pipelines (id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists creative_format_idx on creative (format) where deleted_at is null;
create index if not exists creative_client_idx on creative (client_id) where client_id is not null;

-- Deny-all RLS, matching the lockdown posture (0010/0011); service-role + the
-- SECURITY DEFINER mirror triggers bypass it. The base is internal plumbing, so
-- it is NOT added to the supabase_realtime publication.
alter table creative enable row level security;

-- ---------------------------------------------------------------------------
-- Backfill existing creatives + video_creatives into the base.
-- ---------------------------------------------------------------------------
insert into creative (id, format, client_id, pipeline_id, created_at, deleted_at)
select c.id, 'image'::creative_type, b.client_id, c.pipeline_id, c.created_at, c.deleted_at
  from creatives c
  left join briefs b on b.id = c.brief_id
on conflict (id) do nothing;

insert into creative (id, format, client_id, pipeline_id, created_at, deleted_at)
select vc.id, 'video'::creative_type, vb.client_id, vc.pipeline_id, vc.created_at, vc.deleted_at
  from video_creatives vc
  left join video_briefs vb on vb.id = vc.brief_id
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Mirror new rows. AFTER INSERT so the base row exists before any gate write.
-- ---------------------------------------------------------------------------
create or replace function creative_mirror_image() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into creative (id, format, client_id, pipeline_id, created_at, deleted_at)
  values (new.id, 'image'::creative_type,
          (select client_id from briefs where id = new.brief_id),
          new.pipeline_id, new.created_at, new.deleted_at)
  on conflict (id) do nothing;
  return new;
end
$$;

create or replace function creative_mirror_video() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into creative (id, format, client_id, pipeline_id, created_at, deleted_at)
  values (new.id, 'video'::creative_type,
          (select client_id from video_briefs where id = new.brief_id),
          new.pipeline_id, new.created_at, new.deleted_at)
  on conflict (id) do nothing;
  return new;
end
$$;

drop trigger if exists creatives_mirror_to_creative on creatives;
create trigger creatives_mirror_to_creative
  after insert on creatives for each row execute function creative_mirror_image();

drop trigger if exists video_creatives_mirror_to_creative on video_creatives;
create trigger video_creatives_mirror_to_creative
  after insert on video_creatives for each row execute function creative_mirror_video();
