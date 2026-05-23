-- 0029_harden_rebuild_function_search_path.sql
-- Pin search_path on the three rebuild helper functions the Supabase security
-- advisor flagged (function_search_path_mutable). 0018/0019 defined them with
-- create-or-replace but without the search_path pin; the other rebuild functions
-- (0024/0025) already pin it. These are read-only / trigger helpers (not
-- SECURITY DEFINER), so the risk is low, but pinning clears the lint and matches
-- the project's existing hardening convention (website_harden_function_search_path).
--
-- Applied to the live project (jfzxlsaywztlytnobgej) during go-live; this file
-- keeps the repo migration chain in parity.

alter function public.pipeline_rollup_cleared(uuid, creative_stage_enum)
  set search_path = public, pg_temp;
alter function public.pipeline_work_closed(uuid, pipeline_status_enum)
  set search_path = public, pg_temp;
alter function public.set_updated_at()
  set search_path = public, pg_temp;
