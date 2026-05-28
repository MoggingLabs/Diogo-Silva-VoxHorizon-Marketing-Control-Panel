-- 0055_copy_rearm_scope.sql
-- ----------------------------------------------------------------------------
-- Silent-failure foundational redesign, FIX-D: scope the copy_variants
-- compliance re-arm so APPROVING a draft does not silently block launch.
--
-- THE BUG
-- 0025 created the AFTER INSERT OR UPDATE trigger ``copy_variants_rearm_compliance``
-- (-> compliance_rearm_on_copy_change()), whose intent is "void-on-content-change":
-- when the COPY for a creative is (re-)drafted, its prior compliance verdict is
-- stale and the compliance_review gate must re-arm to 'pending' so the worker
-- re-adjudicates. But the trigger fired on EVERY copy_variants UPDATE -- including
-- the status-only verdict UPDATE that ``POST /api/pipelines/:id/copy/decision``
-- issues to APPROVE a variant (status -> 'approved'). Approving an existing draft
-- introduces NO new content, yet it re-armed compliance_review back to 'pending'.
-- Nothing then re-adjudicates: compliance_run is operator-tool / worker driven and
-- is dispatched only on ENTRY to compliance_review, not on a copy-stage write. So
-- the downstream launch_handoff HARD gate (which re-derives compliance_clear) then
-- silently 422s 'launch_blocked' until each re-armed creative is manually
-- re-cleared via /compliance/override. The failure surfaced far from its cause
-- (a generic launch_blocked at launch, not at the copy approve that caused it).
-- video_copy_variants has no such trigger, so VIDEO was immune; the live IMAGE
-- path was hit on every copy approve.
--
-- THE FIX (firing semantics chosen + why)
-- Re-scope the trigger so it re-arms ONLY when copy CONTENT actually changes:
--   * AFTER INSERT  -> always re-arm (a fresh draft IS new content); and
--   * AFTER UPDATE  -> re-arm ONLY when a copy CONTENT column is distinct from
--                      its old value: headline, body, description, cta, pattern.
-- A status-only verdict UPDATE (approve: status -> 'approved'; reject: status ->
-- 'rejected') leaves all content columns unchanged, so the WHEN clause is false
-- and compliance is NOT re-armed -- the launch_blocked regression is gone.
--
-- Why a CONTENT-column WHEN clause (not "INSERT only", not "status <> approved"):
-- editing a draft's text via UPDATE legitimately IS new content and MUST still
-- re-arm (the prior verdict no longer reflects the live copy). Both content-edit
-- writers -- ``POST /api/pipelines/:id/copy`` (upsert-edit) and ``PATCH
-- /api/copy/:id`` -- change one or more of these five columns when the operator
-- edits copy, so a real edit re-arms exactly as 0025 intended; only the
-- content-unchanged verdict UPDATE is excluded. Comparing the content columns
-- (rather than keying off status) makes the rule robust to how a caller sets
-- status: the trigger re-arms on the SUBSTANCE that compliance adjudicates, not
-- on a status flag. ``humanized`` / ``humanized_at`` are intentionally NOT in the
-- content set -- a humanize-only toggle does not alter the adjudicated claims, so
-- it need not void a prior verdict.
--
-- The function body (compliance_rearm_on_copy_change) is UNCHANGED from 0025; we
-- only narrow the trigger's firing condition. video_copy_variants is untouched and
-- still carries no re-arm trigger (video immunity preserved).
--
-- Forward-only. ``drop trigger if exists`` + ``create trigger`` is idempotent.
-- Depends on: 0025 (the trigger + function), 0020 (copy_variants content columns).
-- ----------------------------------------------------------------------------

-- Drop the over-broad 0025 trigger and recreate it with the same per-row AFTER
-- timing but a content-scoped WHEN clause. On INSERT, OLD is NULL so PostgreSQL
-- requires the WHEN clause to reference only NEW; we therefore split into two
-- triggers that share the one (unchanged) function:
--   * INSERT: unconditional (every fresh draft re-arms);
--   * UPDATE: gated on a copy CONTENT column changing.
drop trigger if exists copy_variants_rearm_compliance on copy_variants;

-- AFTER INSERT: a freshly drafted variant is new content -> always re-arm.
create trigger copy_variants_rearm_compliance_insert
  after insert on copy_variants
  for each row
  execute function compliance_rearm_on_copy_change();

-- AFTER UPDATE: re-arm ONLY when a copy CONTENT column actually changed.
-- ``is distinct from`` treats NULLs correctly (NULL -> text and text -> NULL both
-- count as a change; NULL -> NULL does not). A status-only approve/reject UPDATE
-- leaves every listed column equal, so this trigger does not fire.
create trigger copy_variants_rearm_compliance_update
  after update on copy_variants
  for each row
  when (
       new.headline    is distinct from old.headline
    or new.body        is distinct from old.body
    or new.description is distinct from old.description
    or new.cta         is distinct from old.cta
    or new.pattern     is distinct from old.pattern
  )
  execute function compliance_rearm_on_copy_change();

comment on function compliance_rearm_on_copy_change() is
  'Two-pass compliance re-arm (P2.7, scoped by FIX-D / 0055): a copy_variants '
  'INSERT, or an UPDATE that changes a copy CONTENT column '
  '(headline/body/description/cta/pattern), resets that creative''s '
  'compliance_review gate to pending (void-on-content-change), clearing any stale '
  'override. A status-only approve/reject UPDATE does NOT re-arm. Scoped to the '
  'one affected creative.';
