-- 0011_enable_rls_lockdown.sql
--
-- Phase 2 of the Supabase lockdown: enable Row Level Security (deny-all) on
-- every table in the public schema, plus clean up the remaining security
-- advisor findings (SECURITY DEFINER view, mutable function search_path).
--
-- ---------------------------------------------------------------------------
-- WHY (deny-all by design)
-- ---------------------------------------------------------------------------
-- Phase 1 (0010) revoked write grants from the `anon` + `authenticated`
-- roles, but SELECT was intentionally kept so the dashboard kept working.
-- The public anon key (baked into the browser bundle) could therefore still
-- READ every row directly via PostgREST, bypassing the Caddy edge auth.
--
-- This migration enables RLS on every public table and adds NO policies. With
-- RLS on and no policy, Postgres denies ALL rows to `anon` and
-- `authenticated` regardless of the SELECT grant — so the anon key now has
-- zero useful access (no read, no write, no Realtime row delivery).
--
-- This is SAFE for the dashboard because:
--   * Every server-side data path (route handlers, server components, the
--     SSE Realtime relay, the FastAPI worker) authenticates with the
--     service-role credential (SUPABASE_SECRET_KEY). The `service_role`
--     Postgres role has `rolbypassrls = true`, so it bypasses both RLS and
--     grants — those paths keep working unchanged.
--   * After Phase 2 the browser never talks to Supabase directly; all data
--     flows through the Next.js server, which is gated by Caddy basic auth.
--
-- We deliberately do NOT add per-row policies: there is no Supabase Auth in
-- this deployment (no end-user JWTs), so the only legitimate database client
-- is the trusted server. Deny-all + service-role bypass is the correct model.
--
-- ALTER ... ENABLE ROW LEVEL SECURITY is idempotent (re-running is a no-op
-- once enabled), so this migration is safe to re-apply.

-- ---------------------------------------------------------------------------
-- 1. Enable RLS (deny-all) on all 25 public tables.
--    Source of truth: get_advisors(type=security) rls_disabled_in_public.
-- ---------------------------------------------------------------------------
ALTER TABLE public.approval_mode            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_mode_audit      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approvals                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approvals_policy_cache   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.briefs                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_perf_image      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_perf_video      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copy_variants            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creative_iterations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creatives                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hermes_tasks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.launch_packages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.overrides                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipelines                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_log                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_briefs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_copy_variants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_creatives          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_iterations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_launch_packages    ENABLE ROW LEVEL SECURITY;

-- Document the deny-all intent on a representative table so the design is
-- discoverable from psql (\d+) without reading this migration.
COMMENT ON TABLE public.approvals IS
  'RLS enabled with NO policies = deny-all for anon/authenticated. Only the '
  'service_role (rolbypassrls) reaches this table, via the Next.js server + '
  'FastAPI worker. See db/migrations/0011_enable_rls_lockdown.sql.';

-- ---------------------------------------------------------------------------
-- 2. Recreate v_campaign_perf as SECURITY INVOKER (drop the DEFINER flag).
--
--    The advisor flags this view as SECURITY DEFINER, which would run with
--    the view OWNER's privileges and silently bypass the RLS we just enabled
--    on campaign_perf_image / campaign_perf_video. The view is a plain
--    UNION ALL over those two tables with no privilege-escalation need, so
--    SECURITY INVOKER (the safe default) is correct: callers see it through
--    their own RLS. The only legitimate caller is the service-role server,
--    which bypasses RLS anyway, so behavior is unchanged for the app while
--    the anon key gets no rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_campaign_perf
WITH (security_invoker = true) AS
 SELECT campaign_perf_image.id,
    campaign_perf_image.client_id,
    campaign_perf_image.campaign_id,
    campaign_perf_image.window_days,
    'image'::text AS format,
    campaign_perf_image.spend,
    campaign_perf_image.impressions,
    campaign_perf_image.clicks,
    campaign_perf_image.ctr,
    campaign_perf_image.leads_meta,
    campaign_perf_image.leads_ghl,
    campaign_perf_image.cpl_real,
    campaign_perf_image.freq,
    campaign_perf_image.verdict,
    campaign_perf_image.verdict_reason,
    campaign_perf_image.pulled_at
   FROM campaign_perf_image
UNION ALL
 SELECT campaign_perf_video.id,
    campaign_perf_video.client_id,
    campaign_perf_video.campaign_id,
    campaign_perf_video.window_days,
    'video'::text AS format,
    campaign_perf_video.spend,
    campaign_perf_video.impressions,
    campaign_perf_video.clicks,
    campaign_perf_video.ctr,
    campaign_perf_video.leads_meta,
    campaign_perf_video.leads_ghl,
    campaign_perf_video.cpl_real,
    campaign_perf_video.freq,
    campaign_perf_video.verdict,
    campaign_perf_video.verdict_reason,
    campaign_perf_video.pulled_at
   FROM campaign_perf_video;

-- ---------------------------------------------------------------------------
-- 3. Pin a non-mutable search_path on the four flagged functions.
--
--    A role-mutable search_path lets a caller shadow unqualified object names
--    (e.g. point `briefs` at a malicious table) when invoking the function.
--    All four functions reference public objects unqualified (briefs,
--    video_briefs, pipelines, pipeline_events) and use built-ins from
--    pg_catalog (to_char, now, coalesce, jsonb_*), so we pin
--    `search_path = pg_catalog, public` rather than an empty path — an empty
--    path would break the unqualified table references. The two trigger
--    functions run on INSERT into pipeline_events and are owned by a
--    superuser; pinning the path closes the shadowing vector without
--    rewriting them to fully-qualify every reference.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.gen_brief_id_human(text)            SET search_path = pg_catalog, public;
ALTER FUNCTION public.gen_video_brief_id_human(text)      SET search_path = pg_catalog, public;
ALTER FUNCTION public.pipeline_events_apply_cost_actual() SET search_path = pg_catalog, public;
ALTER FUNCTION public.pipeline_events_auto_advance_done() SET search_path = pg_catalog, public;

-- ---------------------------------------------------------------------------
-- 4. extension_in_public (pg_trgm) — INTENTIONALLY LEFT IN public.
--
--    The advisor flags pg_trgm living in `public` (low-severity WARN). We
--    leave it in place on purpose:
--      * Moving an extension (ALTER EXTENSION pg_trgm SET SCHEMA extensions)
--        relocates its operators/operator-classes and would require a
--        search_path that includes the new schema for any unqualified `%`
--        similarity operator or trigram index to keep resolving — a global,
--        cross-cutting change.
--      * There is no security benefit here: with RLS deny-all + write grants
--        revoked, the anon role cannot reach anything in public regardless of
--        where the extension lives. The WARN is informational, not an
--        exposure.
--      * Audited dependencies: no user table, index, or constraint currently
--        depends on pg_trgm's objects (only the extension's own internal
--        members), so nothing is broken by leaving it — but equally nothing
--        is gained by moving it. Revisit only if a trigram index is added.
