-- ============================================================================
-- 0044_approval_mode_ttl_cap.sql
-- ----------------------------------------------------------------------------
-- Cap the AUTO_APPROVE window length at the DB layer (E6.5).
--
-- Background
-- ----------
-- `approval_mode` (0009) lets the operator flip the voxhorizon-approvals plugin
-- into AUTO_APPROVE, which allows approval-needing tools without a round-trip
-- until `expires_at`. 0009 only constrained that AUTO_APPROVE carries an
-- `expires_at` at all; it placed NO ceiling on how far out that expiry could be,
-- and the worker route allowed up to a 24h TTL. A long AUTO_APPROVE window is an
-- unbounded auto-allow surface: combined with spend / launch tools it is an
-- unbounded-spend / unrestricted-launch window.
--
-- The plugin now (E6.5) refuses to auto-approve spend-class and
-- external-write/launch-class tools at all, and clamps the AUTO_APPROVE window
-- it will honor to at most 1 hour from `set_at`. This migration adds the same
-- 1-hour ceiling at the DB layer so an overlong window can never even be
-- persisted -- defense in depth behind the plugin's read-time clamp.
--
-- Cap
-- ---
-- The granted window is `expires_at - set_at`. We require, for AUTO_APPROVE
-- rows, that `expires_at <= set_at + interval '1 hour'`. ASK / HALT rows keep
-- `expires_at IS NULL` (the 0009 invariant) so they satisfy the cap vacuously.
--
-- Forward-only: never edit a merged migration. This is a NEW numbered file that
-- refines 0009 rather than altering it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Normalize any existing out-of-bounds AUTO_APPROVE row.
-- ---------------------------------------------------------------------------
-- Adding the CHECK constraint would fail if the singleton row currently holds
-- an AUTO_APPROVE window wider than the cap. Reset such a row to the safe
-- default (ASK, no expiry) before the constraint is added. ASK is the
-- fail-safe the plugin already degrades to, so this is a no-surprise clamp.

update approval_mode
set mode = 'ASK',
    expires_at = null,
    set_at = now(),
    note = coalesce(note || ' ' , '')
      || '[0044: AUTO_APPROVE window exceeded 1h cap, reset to ASK]'
where mode = 'AUTO_APPROVE'
  and (expires_at is null or expires_at > set_at + interval '1 hour');

-- ---------------------------------------------------------------------------
-- 2. Add the 1-hour cap CHECK on the AUTO_APPROVE window.
-- ---------------------------------------------------------------------------
-- Only AUTO_APPROVE rows are constrained; the 0009 invariant already forces
-- ASK / HALT rows to have a null expires_at, which passes this check trivially.

alter table approval_mode
  add constraint approval_mode_auto_approve_ttl_cap
  check (
    mode <> 'AUTO_APPROVE'
    or (
      expires_at is not null
      and expires_at <= set_at + interval '1 hour'
    )
  );
