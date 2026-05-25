-- 0045_revoke_execute_on_mirror_trigger_fns.sql
-- ----------------------------------------------------------------------------
-- Harden the three SECURITY DEFINER trigger functions introduced in 0034 so they
-- cannot be invoked directly through the PostgREST RPC surface.
--
-- WHY
-- ---
-- 0034 added creative_mirror_image(), creative_mirror_video() and
-- creative_unmirror() as SECURITY DEFINER functions (they run as the owner so
-- the AFTER INSERT/DELETE triggers can write the deny-all `creative` base). New
-- functions get EXECUTE granted to PUBLIC by default, and PostgREST exposes
-- public-schema functions at /rest/v1/rpc/<name>. The Supabase security advisor
-- flags this (lint 0028/0029): a SECURITY DEFINER function callable by anon /
-- authenticated is a privilege-escalation surface.
--
-- The real exposure here is negligible -- these functions RETURN trigger, so
-- PostgREST will not actually expose them as RPC and Postgres rejects a direct
-- call ("trigger functions can only be called as triggers") -- but the clean,
-- self-describing fix the advisor recommends is to remove EXECUTE from the API
-- roles. This is defense in depth and clears the finding.
--
-- KEY FACT: revoking EXECUTE does NOT affect trigger firing. A trigger invokes
-- its function through the table's trigger mechanism, not the caller's EXECUTE
-- privilege, so creatives / video_creatives inserts and deletes keep mirroring /
-- unmirroring the `creative` base exactly as before. Only a direct RPC call is
-- denied.
--
-- Idempotent (REVOKE of an absent grant is a harmless no-op) and forward-only.
-- We revoke from PUBLIC (which covers anon / authenticated via inheritance) and
-- then from anon / authenticated explicitly, so the end state is deterministic
-- regardless of how the grants were provisioned. service_role / the owner keep
-- their privileges and are unaffected.
-- ----------------------------------------------------------------------------

revoke execute on function public.creative_mirror_image() from public;
revoke execute on function public.creative_mirror_video() from public;
revoke execute on function public.creative_unmirror()     from public;

revoke execute on function public.creative_mirror_image() from anon, authenticated;
revoke execute on function public.creative_mirror_video() from anon, authenticated;
revoke execute on function public.creative_unmirror()     from anon, authenticated;
