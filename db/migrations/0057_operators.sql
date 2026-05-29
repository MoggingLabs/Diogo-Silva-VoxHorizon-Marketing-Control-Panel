-- 0057_operators.sql
-- ----------------------------------------------------------------------------
-- App-layer auth (defense-in-depth): single-operator session login.
--
-- Context: every server route uses the service-role Supabase client with NO
-- per-request identity; the only access boundary today is Caddy HTTP Basic
-- Auth at the edge (`Caddyfile`) plus a default-disabled Tailscale gate in
-- `middleware.ts`. ARCHITECTURE.md deliberately chose single-operator + edge
-- auth + RLS-off. This migration adds the storage for a REAL app-layer
-- session login that keeps the single-operator posture but no longer relies
-- solely on the edge: the login route verifies a presented password against
-- the one operator row's hash, then issues a signed HttpOnly session cookie.
--
-- ONE conceptual row. This is NOT multi-user / multi-tenant (that is the
-- explicit post-v1 rewrite, out of scope here). The `email` unique constraint
-- lets the operator be re-seeded idempotently; the app only ever reads the
-- single configured operator.
--
-- Server reads STAY on the service-role client (RLS bypass) exactly as the
-- rest of the schema. RLS is enabled deny-all here for consistency with every
-- other public table: the browser anon role must never see the password hash;
-- only the trusted server (service_role, rolbypassrls=true) touches this table.
--
-- Additive + forward-only. Nothing existing is altered or dropped. Never edited
-- once merged.
-- ----------------------------------------------------------------------------

create table operators (
  id            uuid primary key default gen_random_uuid(),
  -- Stored lowercased by the app (lib/auth/session.ts normalises on read +
  -- compare); the unique constraint then enforces a single canonical row per
  -- address regardless of the case the operator typed at the login form.
  email         text not null unique,
  -- bcrypt hash (bcryptjs, cost >= 10). Never the plaintext; the login route
  -- runs a constant-time `bcrypt.compare` against the presented password.
  password_hash text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- updated_at maintenance via the shared trigger from 0018.
create trigger operators_set_updated_at
  before update on operators
  for each row execute function set_updated_at();

-- ----------------------------------------------------------------------------
-- RLS deny-all (the established pattern: service-role writes/reads via the
-- Next server; the browser never connects directly). Enabling RLS with NO
-- policies denies anon + authenticated entirely; service_role bypasses RLS.
-- ----------------------------------------------------------------------------

alter table operators enable row level security;
