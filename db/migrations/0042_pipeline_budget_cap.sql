-- 0042_pipeline_budget_cap.sql
-- ----------------------------------------------------------------------------
-- E4.4 (#506): a SERVER-SIDE hard budget cap per pipeline.
--
-- Spend control was only a per-ad pre-flight ESTIMATE (routes/video.py refuses a
-- single ad whose generation would exceed the brief's per-ad budget). Nothing
-- bounded a pipeline's CUMULATIVE actual spend across retries, iterations, and
-- many ads, so the running total could overrun. M4 built the consolidated
-- cost_ledger + sum_costs + check_budget, but check_budget was a gauge, never an
-- enforced hard cap.
--
-- This adds an OPTIONAL per-pipeline override column. The worker
-- (services.cost_ledger.resolve_pipeline_cap) reads it first and falls back to
-- the agency-wide config default (PIPELINE_BUDGET_CAP_USD) when it is NULL, so
-- the cap is enforced for every pipeline without requiring a per-row value. The
-- worker reserves-then-checks the estimate against the summed ACTUAL ledger
-- before any paid vendor call and refuses (HTTP 402) when it would exceed the
-- cap -- enforced regardless of approval mode (an AUTO_APPROVE window records the
-- same cost lines, so it cannot push cumulative spend past the cap).
--
-- A NULL cap means "use the config default" (the common case); a positive value
-- overrides it for that pipeline; a value <= 0 is rejected so it can never be a
-- silent "no cap". Forward-only and idempotent.
-- ----------------------------------------------------------------------------

alter table pipelines
  add column if not exists budget_cap_usd numeric;

alter table pipelines
  drop constraint if exists pipelines_budget_cap_usd_positive;
alter table pipelines
  add constraint pipelines_budget_cap_usd_positive
  check (budget_cap_usd is null or budget_cap_usd > 0);

comment on column pipelines.budget_cap_usd is
  'E4.4 (#506) optional per-pipeline hard spend cap in USD enforced server-side '
  'against the summed cost_ledger before any paid vendor call. NULL falls back '
  'to the worker config default PIPELINE_BUDGET_CAP_USD.';
