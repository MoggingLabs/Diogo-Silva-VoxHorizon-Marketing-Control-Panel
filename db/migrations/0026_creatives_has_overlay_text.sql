-- 0026_creatives_has_overlay_text.sql
-- Add the `creatives.has_overlay_text` column the QA + compliance routes read.
--
-- The worker's `_fetch_creative` (worker/src/routes/qa_compliance.py) selects
-- `has_overlay_text` so the compliance engine can evaluate the
-- `google.overlay_text` rule (`field_predicate` on `has_overlay_text`) and the
-- QA engine can reason about baked-in overlay text. The column was never added
-- by the rebuild migrations (0017–0025) — the worker's unit tests drive the
-- in-memory fake_supabase double, so the gap never surfaced. Against a real
-- Postgres / PostgREST the `select ..., has_overlay_text` 400s, which breaks
-- `/work/pipeline/tools/qa_run` and `/work/pipeline/tools/compliance_run` and
-- thus stalls the creative_qa → compliance_review portion of the pipeline.
--
-- Forward-only. Defaults to false (no overlay) so existing rows pass the
-- overlay-text-free Google check by default; the operator/render pipeline sets
-- it true when a creative bakes in an offer stamp / CTA.

alter table creatives
  add column if not exists has_overlay_text boolean not null default false;

comment on column creatives.has_overlay_text is
  'True when the creative bakes in overlay text (offer stamp / CTA). Read by '
  'the QA + compliance engines (google.overlay_text rule). Added in 0026 — the '
  'rebuild migrations omitted it; the worker has always selected it.';
