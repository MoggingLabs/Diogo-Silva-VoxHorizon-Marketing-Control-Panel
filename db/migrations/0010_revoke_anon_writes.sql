-- 0010_revoke_anon_writes.sql
--
-- Phase 1 of the Supabase lockdown: strip write capability from the public
-- `anon` + `authenticated` roles on every table in the public schema.
--
-- WHY: RLS is off and these roles had full CRUD (incl. TRUNCATE) on all
-- tables. The Supabase PostgREST endpoint is public and the anon key is
-- public (baked into the browser bundle), so anyone on the internet could
-- read/forge/destroy data directly, bypassing the dashboard's Caddy edge
-- auth entirely. Verified live: the anon key read real rows from `approvals`
-- and `approval_mode_audit`.
--
-- WHY THIS IS SAFE FOR THE DASHBOARD: the browser never writes to Supabase
-- directly — every write goes through a Next.js API route using the
-- service-role credential (SUPABASE_SECRET_KEY via createAdminClient), which
-- bypasses grants. SELECT is intentionally KEPT so server-component reads and
-- client-side Realtime keep working until Phase 2.
--
-- PHASE 2 (separate PR) closes the remaining read exposure: enable RLS
-- deny-all on all tables, switch lib/supabase/server.ts to the service-role
-- key for server-component reads, and replace client-side Realtime with a
-- server-side SSE relay (Next.js holds the Realtime subscription with
-- service-role and relays to the browser behind basic auth). After Phase 2,
-- the anon key has no useful access at all.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public
  FROM anon, authenticated;

-- Future tables created by the postgres role must not auto-grant writes back
-- to anon/authenticated (Supabase's default grant behavior).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLES FROM anon, authenticated;
