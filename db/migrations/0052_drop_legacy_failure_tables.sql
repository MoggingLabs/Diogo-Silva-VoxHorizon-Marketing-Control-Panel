-- 0052_drop_legacy_failure_tables.sql
-- ----------------------------------------------------------------------------
-- Silent-failure architectural redesign, PR-7 (final disposal).
--
-- Drops the three per-domain failure tables that 0050's work_item queue
-- replaced and 0051 renamed to `_legacy_*` (one-quarter retention). PR-6
-- migrated the last application readers (observability metrics, the kie
-- submit/callback path, and run_kie_reconcile_once) onto `work_item`, so the
-- legacy tables now have ZERO readers and ZERO writers. A post-PR-6 telemetry
-- soak (pg_stat_user_tables) confirmed their scan counters stayed flat across
-- a full observability cycle, and a four-dimension code audit (DB / worker /
-- dashboard / docs) confirmed no live code references them -- only tombstone
-- comments remain.
--
-- Dependency-safe: each table is referenced ONLY by its own
-- PK/UNIQUE/CHECK indexes, an OUTBOUND FK (to pipelines / video_briefs /
-- video_creatives), and a `set_updated_at` trigger -- all auto-dropped with
-- the table. No non-legacy object references them: no inbound FK, no view,
-- rule, function, or policy, and they are not in the `supabase_realtime`
-- publication (0051 removed them). Hence no CASCADE is required.
--
-- CASCADE is deliberately OMITTED: if an unexpected new inbound dependency
-- exists, the DROP should fail LOUDLY rather than silently cascade. The
-- publication-drop below is belt-and-braces (the tables are already absent
-- from the publication).
-- ----------------------------------------------------------------------------

do $$
declare
  rel text;
begin
  foreach rel in array array[
    '_legacy_operator_dispatches',
    '_legacy_integration_outbox',
    '_legacy_video_render_tasks'
  ] loop
    if exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = rel
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', rel);
    end if;
  end loop;
end$$;

drop table if exists public._legacy_integration_outbox;
drop table if exists public._legacy_operator_dispatches;
drop table if exists public._legacy_video_render_tasks;
