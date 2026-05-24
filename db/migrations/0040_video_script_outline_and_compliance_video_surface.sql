-- 0040_video_script_outline_and_compliance_video_surface.sql
-- ----------------------------------------------------------------------------
-- M3: two coupled, additive changes for the video spoken-claim compliance gate.
--
-- The HARD compliance gate evaluates copy + image text, but a VIDEO can SAY a
-- non-compliant claim (FTC substantiation, financial, prohibited claim) in its
-- voiceover script with nothing catching it. This migration persists the spoken
-- script where the gate can read it and lets the spoken-claim rules seed.
--
--   1. Persist the generated script_outline on video_creatives. The script is
--      the video's *spoken* surface (hook + per-segment voiceover_text + outro)
--      and the only compliance surface invisible to the image/copy checks.
--      script_outline today lives ONLY on video_briefs (0001) and in
--      video_iterations.content; routes.video._script_of's PRIMARY path
--      (creative.script_outline) is therefore dead and the voiceover stage
--      silently falls back to the brief payload. Making it a first-class column
--      lets the generated script flow to the voiceover stage AND give the
--      compliance gate one reliable per-creative source.
--
--   2. Allow 'video' as a compliance_rule.surface. The surface CHECK was
--      ('image','copy','targeting') (migration 0021); the new spoken-claim rules
--      carry surface='video' and must seed into the lookup table (the seed is
--      best-effort, but a constraint violation would skip the whole batch).
--
-- Forward-only. Both changes are idempotent.
-- ----------------------------------------------------------------------------

alter table video_creatives
  add column if not exists script_outline jsonb;

alter table compliance_rule
  drop constraint if exists compliance_rule_surface_check;
alter table compliance_rule
  add constraint compliance_rule_surface_check
  check (surface in ('image', 'copy', 'targeting', 'video'));
