-- ============================================================================
-- 0009_approval_mode.sql
-- ----------------------------------------------------------------------------
-- Operator-controlled approval mode toggle (Wave 24 — approval-mode-toggle).
--
-- The voxhorizon-approvals Hermes plugin defaults to ASKing the operator for
-- every sensitive tool call. This feature lets the operator switch the
-- plugin's behavior between three modes from the dashboard Settings tab:
--
--   * ASK          — long-poll the dashboard for an operator decision
--   * AUTO_APPROVE — allow without asking (TTL-bounded, 1h .. 24h)
--   * HALT         — block all approval-needing tools until cleared
--
-- State lives in `approval_mode` (singleton row, id='singleton'). Every
-- transition writes one audit row to `approval_mode_audit`.
--
-- Tables:
--   * approval_mode        — singleton state row (id='singleton' UNIQUE)
--   * approval_mode_audit  — append-only transition log
--
-- Realtime: the plugin/dashboard subscribe to `approval_mode` so a mode
-- change in the dashboard propagates to the plugin's 5s in-process cache
-- on the next refresh.
--
-- RLS stays OFF (single-operator app behind Tailscale + Caddy basic auth).
--
-- Forward-only: never edit a merged migration. New refinements go into a
-- new numbered file.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. approval_mode — singleton state row
-- ---------------------------------------------------------------------------
-- One-and-only-one row keyed on the literal text 'singleton' so the table
-- can't accidentally accumulate competing rows. CHECK constraint enforces
-- the singleton invariant; the PK + CHECK pair means an INSERT of any
-- other id is a hard error.

create table approval_mode (
  id text primary key default 'singleton'
    check (id = 'singleton'),
  mode text not null default 'ASK'
    check (mode in ('ASK', 'AUTO_APPROVE', 'HALT')),
  expires_at timestamptz,
  set_by text,
  set_at timestamptz not null default now(),
  note text,
  -- Only AUTO_APPROVE may carry expires_at; ASK / HALT must leave it null
  -- so the plugin's "expired AUTO_APPROVE drops back to ASK" check is
  -- unambiguous.
  constraint approval_mode_expires_at_only_on_auto_approve
    check (
      (mode = 'AUTO_APPROVE' and expires_at is not null)
      or (mode <> 'AUTO_APPROVE' and expires_at is null)
    )
);

-- Seed the singleton row at ASK (the safe default).
insert into approval_mode (id, mode)
values ('singleton', 'ASK')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. approval_mode_audit — append-only transition log
-- ---------------------------------------------------------------------------
-- One row per mode transition. The plugin / worker / dashboard all share
-- this trail so the operator can answer "who flipped the mode at 03:14?".
--
-- `changed_by` is "dashboard" for v1; once SSO lands it will become the
-- `auth.user.id` of the operator. Auto-expiry transitions (AUTO_APPROVE →
-- ASK after TTL) write `changed_by='expired'`.
--
-- `ttl_seconds` is only meaningful when the transition target is
-- AUTO_APPROVE — for other transitions it stays NULL. We don't CHECK
-- that here because audit is forensics, not enforcement, and a stale
-- row is preferable to an aborted insert.

create table approval_mode_audit (
  id uuid primary key default gen_random_uuid(),
  from_mode text not null,
  to_mode text not null,
  ttl_seconds int,
  changed_at timestamptz not null default now(),
  changed_by text not null,
  note text
);

-- Newest-first index for "recent transitions" queries (the Settings page
-- shows the last ~50 rows). DESC so the planner can scan the index
-- backward without an extra Sort node.
create index approval_mode_audit_recent
  on approval_mode_audit(changed_at desc);

-- ---------------------------------------------------------------------------
-- 3. Realtime publication
-- ---------------------------------------------------------------------------
-- The dashboard subscribes to approval_mode so the sidebar badge / banner
-- update within ~1s of any mode change. The audit table doesn't need
-- realtime — the page re-fetches on focus.

alter publication supabase_realtime add table approval_mode;
