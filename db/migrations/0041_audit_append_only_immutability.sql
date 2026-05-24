-- 0041_audit_append_only_immutability.sql
--
-- E6.4 (#532): make the genuinely APPEND-ONLY audit / evidence tables
-- tamper-evident at the DB layer by removing UPDATE + DELETE from the writer
-- role (service_role), while keeping INSERT + SELECT.
--
-- ---------------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------------
-- The whole stack writes Supabase with ONE credential: the service_role key
-- (SUPABASE_SECRET_KEY) used by the Next.js server and the FastAPI worker.
-- service_role has `rolbypassrls = true`, so RLS (0011) does not constrain it.
-- That means, until now, "the audit trail is mutable by the same key the agent
-- uses" was literally true: the agent could silently rewrite or erase its own
-- compliance / QA / pipeline / approval-mode history.
--
-- KEY FACT that makes this revoke EFFECTIVE (not cosmetic): `rolbypassrls`
-- bypasses row-level security policies ONLY. It does NOT bypass table-level
-- GRANT privileges. service_role is `nologin bypassrls` (see
-- db/ci-bootstrap.sql) -- it is NOT a superuser and does NOT own these tables.
-- So once UPDATE / DELETE are revoked, an UPDATE / DELETE issued with the
-- service_role key is rejected by Postgres with `permission denied`, while
-- INSERT (the append) and SELECT (read-back) keep working. The worker / web
-- paths only ever INSERT and SELECT these tables (verified table-by-table
-- below), so nothing in the application breaks.
--
-- We GRANT INSERT, SELECT explicitly first so the end state is self-describing
-- and deterministic regardless of how the role was provisioned: on hosted
-- Supabase service_role already holds these (this re-grant is a harmless
-- no-op); in CI / the integration tier the role starts grant-less, so the
-- explicit grant is what lets the append keep working after the revoke. Both
-- the grant and the revoke are idempotent and forward-only (re-running this
-- migration is a no-op), matching db/docs/migrations.md.
--
-- ---------------------------------------------------------------------------
-- SCOPE: ONLY tables proven append-only (zero legitimate UPDATE/DELETE) by a
-- full grep of the worker (worker/src), web (app/, lib/), and ekko-skills
-- code paths. Each table carries its evidence inline. Tables that ARE mutated
-- in code are deliberately EXCLUDED (see the EXCLUSIONS block at the bottom).
-- ---------------------------------------------------------------------------

-- events -- domain audit log (0001). Code paths: worker
-- services/atomic_inserts.py, atomic_inserts_video.py, notifications.py and
-- routes/creative.py all `.insert(...)`; the web app/api/** routes
-- `.from("events").insert(...)`; app/**/page.tsx only `.from("events").select`.
-- No `.update` / `.delete` against events anywhere. Append-only.
grant insert, select on public.events to service_role;
revoke update, delete on public.events from service_role;
revoke update, delete on public.events from anon, authenticated;
comment on table public.events is
  'Append-only domain audit log. UPDATE/DELETE revoked from service_role '
  '(0041, E6.4): the writer key can append + read but cannot rewrite or erase '
  'history. Only INSERT/SELECT are used in code.';

-- pipeline_events -- per-pipeline timeline / task lifecycle (0006). Code paths:
-- worker services/pipeline_runner.py, hermes_webhook.py and routes/
-- pipeline_tools.py `.insert(...)`; web app/api/** `.from("pipeline_events")
-- .insert(...)`; the task-retry route SELECTs the source event then INSERTs a
-- NEW task_queued row rather than updating it (app/api/pipelines/[id]/tasks/
-- [task_event_id]/retry/route.ts); ekko-skills POST /rest/v1/pipeline_events.
-- No `.update` / `.delete`. (Inbound `pipeline_id ... on delete cascade` from
-- pipelines is fine -- that is a parent-driven cascade, not a writer UPDATE.)
grant insert, select on public.pipeline_events to service_role;
revoke update, delete on public.pipeline_events from service_role;
revoke update, delete on public.pipeline_events from anon, authenticated;
comment on table public.pipeline_events is
  'Append-only pipeline timeline. UPDATE/DELETE revoked from service_role '
  '(0041, E6.4). Lifecycle changes are NEW rows (e.g. retry appends '
  'task_queued, never edits the task_error). Inbound ON DELETE CASCADE from '
  'pipelines is intentional and unaffected.';

-- approval_mode_audit -- append-only approval-mode transition log (0009). Code
-- paths: worker services/hermes_approval_mode.py `.insert(...)` (set_mode) and
-- `.select(...)` (get_audit_rows); web app/api/approval-mode/audit/route.ts
-- reads rows newest-first. No `.update` / `.delete`. Append-only.
grant insert, select on public.approval_mode_audit to service_role;
revoke update, delete on public.approval_mode_audit from service_role;
revoke update, delete on public.approval_mode_audit from anon, authenticated;
comment on table public.approval_mode_audit is
  'Append-only approval-mode transition log. UPDATE/DELETE revoked from '
  'service_role (0041, E6.4): each mode change is one immutable INSERT.';

-- qa_result -- append-only QA evidence, one row per attempt (0021). Code path:
-- worker routes/qa_compliance.py counts existing rows, increments `attempt`,
-- and INSERTs a NEW row ("a fresh, append-only attempt rather than an
-- overwrite"); `unique (creative_id, attempt)` enforces the no-overwrite rule.
-- No `.update` / `.delete` against qa_result. Append-only.
grant insert, select on public.qa_result to service_role;
revoke update, delete on public.qa_result from service_role;
revoke update, delete on public.qa_result from anon, authenticated;
comment on table public.qa_result is
  'Append-only QA evidence (one row per re-render attempt). UPDATE/DELETE '
  'revoked from service_role (0041, E6.4): a re-check INSERTs the next '
  'attempt; prior attempts are immutable.';

-- ---------------------------------------------------------------------------
-- EXCLUSIONS (deliberately NOT revoked -- these tables ARE mutated in code, so
-- revoking UPDATE/DELETE would break the worker / web. Recorded here so the
-- next reviewer does not have to re-derive the analysis):
--
--   * spec_check        -- UPSERTED by the worker for idempotent resume:
--                          operator_stage_tools.py does
--                          `sb.table("spec_check").update(row).eq("id", ...)`
--                          when a (creative_id, platform, placement) row
--                          already exists. NOT append-only.
--   * sync_log          -- designed for an update-after-insert lifecycle
--                          (status defaults to 'running'; finished_at /
--                          rows_upserted / status / error_text are finalised
--                          by a later UPDATE when the run completes). No code
--                          writes it yet, but the planned cron heartbeat
--                          (infra/monitoring + a future services/heartbeat.py
--                          log_success) WILL update it. Excluded under
--                          "when in doubt, exclude".
--   * compliance_finding -- UPDATED by the compliance override path (web
--                          app/api/pipelines/[id]/compliance/override/route.ts
--                          sets overridden=true + audit columns). Mutable by
--                          design; out of scope for E6.4.
--   * creative_stage_state -- the per-(creative, stage) gate row is UPDATED on
--                          every gate transition (worker operator_stage_tools.py
--                          / qa_compliance.py; web override route). Mutable by
--                          design.
--
-- DEFERRED (tracked as E6.4 follow-ups, NOT in this migration):
--   * Hash-chaining   -- chain each appended row to the prior row's hash so a
--                        privileged DELETE (a superuser / direct psql) is
--                        detectable, not just blocked at the grant layer.
--   * WORM export     -- periodic write-once-read-many export of these tables
--                        to immutable object storage (S3 Object Lock / similar)
--                        for off-box tamper-evidence and retention.
-- ---------------------------------------------------------------------------
