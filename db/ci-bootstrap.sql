-- db/ci-bootstrap.sql
-- ----------------------------------------------------------------------------
-- Supabase scaffolding the migration chain references but a bare Postgres lacks.
-- Applied BEFORE the migrations by (a) the CI migration-apply job and (b) the
-- integration test harness (worker/tests/integration/conftest.py). Single source
-- so the two cannot drift. Idempotent; adds NO application schema, only the
-- Supabase roles / publication / storage objects the forward-only DDL leans on.
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  -- 0010 runs `alter default privileges for role postgres ...`; a throwaway
  -- container superuser may not be named "postgres", so make sure it exists.
  if not exists (select 1 from pg_roles where rolname = 'postgres') then
    create role postgres login superuser;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

create schema if not exists storage;
create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);
