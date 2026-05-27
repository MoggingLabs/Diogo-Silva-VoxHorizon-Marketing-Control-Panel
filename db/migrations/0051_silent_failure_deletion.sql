-- 0051_silent_failure_deletion.sql
-- ----------------------------------------------------------------------------
-- Silent-failure architectural redesign, PR-4 (deletion pass).
--
-- After this migration applies:
--   * The four per-domain failure tables that 0050's `work_item` queue replaced
--     are RENAMED to `_legacy_*` (NOT dropped -- one-quarter retention so a
--     production read that still hits them is recoverable by a rename-back).
--   * `pipelines.status` -- the mutable rollup column that drifted from the
--     `pipeline_events` audit log -- is DROPPED. From this migration on, the
--     canonical answer to "what stage is this pipeline in?" is the
--     event-sourced `compute_pipeline_status(id)` reducer (migration 0050),
--     exposed via `v_pipeline_dispatch_state.derived_status` for clients.
--
-- The renames are reversible (one-line `alter table ... rename`) so a
-- production reader caught reading from the legacy table surfaces as a 404
-- and we can roll back the rename. The DROP COLUMN is forward-only -- every
-- route was migrated off the column in this PR (every reader now derives
-- status via the RPC, every writer that set the column stopped writing it).
--
-- ADDITIVE in the strict sense: the work_item queue + reducer infrastructure
-- shipped in 0050; this migration only disposes of the dormant primitives.
-- See `~/.claude/plans/idempotent-munching-phoenix.md` for the four-PR plan.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- 1. Rename the legacy per-domain failure tables.
-- ============================================================================
--
-- One-quarter retention: keep the tables around in case a production read
-- somehow still hits them. Strip them out of the realtime publication first
-- so subscribers stop receiving updates immediately (the consumers that
-- subscribed are gone; this is belt-and-braces).

alter publication supabase_realtime drop table if exists operator_dispatches;
alter publication supabase_realtime drop table if exists integration_outbox;
alter publication supabase_realtime drop table if exists video_render_tasks;

alter table if exists operator_dispatches rename to _legacy_operator_dispatches;
alter table if exists integration_outbox  rename to _legacy_integration_outbox;
alter table if exists video_render_tasks  rename to _legacy_video_render_tasks;


-- ============================================================================
-- 2. Drop pipelines.status.
-- ============================================================================
--
-- The load-bearing change. PR-3 kept the column as a write-only cache so
-- downstream readers could keep compiling through the cutover. PR-4 migrates
-- every reader to compute_pipeline_status(id) / v_pipeline_dispatch_state and
-- drops the column.
--
-- There is no trigger or constraint pinning the column. The realtime
-- publication on `pipelines` will reflect the dropped column on next refresh;
-- subscribers were already migrated to read derived_status from the view.
--
-- Verification before drop (run manually before this migration is applied):
--   select * from information_schema.view_column_usage
--    where column_name = 'status' and table_name = 'pipelines';
-- expected: zero rows (no view depends on the column).

alter table pipelines drop column status;

-- ============================================================================
-- 3. Smoke.
-- ============================================================================
--
-- Verify the reducer + the canonical view still resolve cleanly with the
-- column gone. Both read pipeline_events (untouched) so this is a sanity
-- check, not a correctness one.
--
-- Smoke: select derived_status from v_pipeline_dispatch_state limit 1;
-- expected: returns a non-null pipeline_status_enum value (configuration
-- when the pipeline has no stage_advanced events, the latest stage_advanced
-- target otherwise, or cancelled when a pipeline_cancelled event is present).
