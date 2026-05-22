-- 0020_rebuild_copy_variants.sql
-- Wire copy_variants for the in-pipeline copy stage. The table exists (0001)
-- but is structurally insufficient and EMPTY (0 rows), so we extend it
-- additively rather than drop/recreate -- additive ALTER preserves the table's
-- existing realtime-publication membership and grants, and is zero-risk on an
-- empty table.
--
-- Kept as-is (existing reads in lib/launches.ts + components/launch keep working):
--   headline, body (= Meta "primary text"), cta, humanized, status.
-- Added: pipeline link, platform/placement, the separate Meta `description`
-- line, variant ordering, winning-copy `pattern` lineage, a `validation` jsonb
-- (char-count + policy pre-check results), humanizer + approval provenance.
-- status is promoted text -> copy_variant_status_enum ('draft' is preserved).

alter table copy_variants
  add column if not exists pipeline_id   uuid references pipelines (id) on delete cascade,
  add column if not exists variant_index int not null default 1,
  add column if not exists platform      platform_enum not null default 'meta',
  add column if not exists placement     placement_enum,
  add column if not exists description   text,
  add column if not exists pattern       text,
  add column if not exists humanized_at  timestamptz,
  add column if not exists author        text not null default 'operator',
  add column if not exists approved_by   text,
  add column if not exists approved_at   timestamptz,
  add column if not exists decided_notes text,
  add column if not exists updated_at    timestamptz not null default now();

comment on column copy_variants.body is 'Meta "primary text" (kept as `body` for back-compat).';
comment on column copy_variants.validation is 'Char-count + policy pre-check results, shared by editor + launch validator.';

-- status text -> enum. Table is empty so the cast is trivial; drop the text
-- default first, convert, then restore the enum default.
alter table copy_variants alter column status drop default;
alter table copy_variants
  alter column status type copy_variant_status_enum using status::copy_variant_status_enum;
alter table copy_variants alter column status set default 'draft';

-- A clean 1..N variant set per (creative, platform). Launch requires >=3 approved.
create unique index if not exists copy_variants_creative_platform_variant_idx
  on copy_variants (creative_id, platform, variant_index);

-- Hot path for the launch precondition ">=3 approved copy variants per creative".
create index if not exists copy_variants_approved_idx
  on copy_variants (creative_id)
  where status = 'approved';

create index if not exists copy_variants_pipeline_idx
  on copy_variants (pipeline_id)
  where pipeline_id is not null;

create trigger copy_variants_set_updated_at
  before update on copy_variants
  for each row execute function set_updated_at();

-- copy_variants already has RLS enabled (0011) and is already in the
-- supabase_realtime publication (0002) -- additive ALTER preserves both, so no
-- re-statement needed here.
