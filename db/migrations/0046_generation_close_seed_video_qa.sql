-- 0046_generation_close_seed_video_qa.sql
-- ----------------------------------------------------------------------------
-- B1: make the generation-close trigger seed the creative_qa gate for VIDEO
-- creatives, not just image.
--
-- THE BUG. pipeline_events_auto_advance_done() (0024) advances a pipeline from
-- `generation` to `creative_qa` and seeds one pending creative_stage_state gate
-- row per FINAL creative. The seed only ever joined `creatives` (the image
-- table) on `image_brief_id` / type='image' / version like 'v1%'. So a VIDEO or
-- BOTH pipeline flips to `creative_qa` with ZERO video gate rows, and
-- pipeline_rollup_cleared() (0039) requires >= 1 in-scope row to clear -- so the
-- very next advance (creative_qa -> compliance_review) 422s forever. The
-- 12-stage DAG is format-agnostic and the shared gate tables FK the neutral
-- `creative` base (0034/0035), so a video creative CAN own a gate row; only the
-- seeding step was image-hardwired. See VIDEO-ARCHITECTURE.md (Layer B: video
-- runs the SAME 12 gates as image).
--
-- THE FIX. create-or-replace the function with the image seed UNCHANGED and an
-- additional, parallel seed from `video_creatives`:
--   * join on the pipeline's `video_brief_id` (the video lineage),
--   * the finished, shippable render is `status = 'captioned'` (video has no
--     v1-style version marker -- `video_creatives.version` is an int default 1 --
--     and the captioned MP4 is the deliverable that enters QA; see the
--     video_creative_status enum + atomic_inserts_video lifecycle
--     script -> ... -> composed -> captioned -> approved),
--   * skip soft-deleted rows, idempotent via the (creative_id, stage) conflict.
-- A BOTH pipeline now seeds image AND video gate rows; an image-only pipeline is
-- unaffected (its video join matches nothing); a video-only pipeline finally
-- seeds its gate. The advance/status logic, the all-failed guard, the closure
-- heuristic and the stage_advanced event are byte-identical to 0024.
--
-- Forward-only: 0024 is never edited; this create-or-replace updates the function
-- body in place and the existing trigger keeps calling it. search_path is
-- re-pinned (a create-or-replace drops the pin) per the 0029 convention.
-- ----------------------------------------------------------------------------

create or replace function pipeline_events_auto_advance_done()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
declare
  v_cutoff_id uuid;
  v_cutoff_ts timestamptz;
  v_queued bigint;
  v_running bigint;
  v_done bigint;
  v_error bigint;
  v_expected bigint;
  v_pipeline_status text;
  v_updated_count int;
  v_now timestamptz := now();
begin
  if new.kind not in ('task_done', 'task_error') then
    return new;
  end if;
  if new.stage is distinct from 'generation' then
    return new;
  end if;

  select status into v_pipeline_status
    from pipelines
   where id = new.pipeline_id;
  if v_pipeline_status is null or v_pipeline_status <> 'generation' then
    return new;
  end if;

  select id, created_at into v_cutoff_id, v_cutoff_ts
    from pipeline_events
   where pipeline_id = new.pipeline_id
     and kind = 'stage_advanced'
     and stage = 'generation'
   order by created_at desc, id desc
   limit 1;
  if v_cutoff_id is null then
    return new;
  end if;

  select
      count(*) filter (where kind = 'task_queued'),
      count(*) filter (where kind = 'task_running'),
      count(*) filter (where kind = 'task_done'),
      count(*) filter (where kind = 'task_error')
    into v_queued, v_running, v_done, v_error
    from pipeline_events
   where pipeline_id = new.pipeline_id
     and stage = 'generation'
     and id <> v_cutoff_id
     and created_at >= v_cutoff_ts;

  -- Closure heuristic (Ekko emits queued+running+done; operator emits running+done).
  v_expected := greatest(coalesce(v_queued, 0), coalesce(v_running, 0));
  -- Not closed yet, OR an all-failed batch (v_done = 0) which must NOT advance.
  if v_expected = 0 or (v_done + v_error) < v_expected or v_done < 1 then
    return new;
  end if;

  update pipelines
     set status = 'creative_qa',
         advanced_at = coalesce(advanced_at, '{}'::jsonb)
                       || jsonb_build_object('creative_qa', to_jsonb(v_now)),
         updated_at = v_now
   where id = new.pipeline_id
     and status = 'generation';

  get diagnostics v_updated_count = row_count;

  if v_updated_count > 0 then
    -- Seed the per-creative QA gate for each final IMAGE creative (idempotent).
    insert into creative_stage_state (pipeline_id, creative_id, stage, status)
    select p.id, c.id, 'creative_qa', 'pending'
      from pipelines p
      join creatives c
        on c.brief_id = p.image_brief_id
       and c.type = 'image'
       and c.version like 'v1%'
       and c.deleted_at is null
     where p.id = new.pipeline_id
    on conflict (creative_id, stage) do nothing;

    -- B1: seed the per-creative QA gate for each final VIDEO creative. The
    -- captioned render is the deliverable that enters QA; video_creatives ids
    -- are valid creative_stage_state.creative_id values via the 0034/0035
    -- neutral `creative` base + FK repoint. Idempotent.
    insert into creative_stage_state (pipeline_id, creative_id, stage, status)
    select p.id, vc.id, 'creative_qa', 'pending'
      from pipelines p
      join video_creatives vc
        on vc.brief_id = p.video_brief_id
       and vc.status = 'captioned'
       and vc.deleted_at is null
     where p.id = new.pipeline_id
    on conflict (creative_id, stage) do nothing;

    insert into pipeline_events (pipeline_id, kind, stage, payload)
    values (
      new.pipeline_id,
      'stage_advanced',
      'creative_qa',
      jsonb_build_object(
        'reason', 'auto_advance',
        'from', 'generation',
        'task_done_count', v_done,
        'task_error_count', v_error
      )
    );
  end if;

  return new;
end;
$$;
