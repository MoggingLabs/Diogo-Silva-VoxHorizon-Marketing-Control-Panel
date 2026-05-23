-- 0021_compliance_qa_spec_tables.sql
-- Append-only EVIDENCE tables for the compliance + QA + spec stages, plus the
-- two versioned LOOKUP tables that hold the rulesets (compliance_rule is a
-- lookup, NOT an enum, because Meta/FTC policy churns). The per-(creative,stage)
-- gate verdict lives in creative_stage_state (0018); these tables hold the
-- queryable, tamper-evident detail (rule + version + evidence + frozen citation
-- + override audit). Evidence tables are intentionally NOT published to realtime
-- (the UI reads creative_stage_state live and pulls evidence on demand).

-- ---------------------------------------------------------------------------
-- Lookup: compliance rules (versioned, citation-bearing).
-- ---------------------------------------------------------------------------
create table compliance_rule (
  rule_id             text not null,
  version             int not null default 1,
  title               text not null,
  authority           text not null,                       -- 'meta' | 'ftc' | 'google' | 'client'
  applies_to_vertical text[] not null default array['*'],  -- '*' = all service_types
  surface             text not null check (surface in ('image', 'copy', 'targeting')),
  severity            verdict_severity_enum not null,
  engine              text not null default 'both' check (engine in ('deterministic', 'llm', 'both')),
  check_spec          jsonb not null default '{}'::jsonb,  -- the JSON-rule DSL
  required_edit       text,
  citation_url        text not null,                       -- no rule without a source
  effective_from      date,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (rule_id, version)
);
comment on table compliance_rule is 'Versioned, citation-bearing compliance ruleset (policy-as-code). Seeded in P2.';
create index compliance_rule_active_idx on compliance_rule (rule_id) where active;
create trigger compliance_rule_set_updated_at
  before update on compliance_rule for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Lookup: QA rubric (defect classes + vertical sub-rubrics).
-- ---------------------------------------------------------------------------
create table qa_rubric (
  check_id            text not null,
  version             int not null default 1,
  title               text not null,
  defect_class        text not null,                       -- hands|text_glyphs|anatomy|surface_artifact|resolution|...
  applies_to_vertical text[] not null default array['*'],
  engine              text not null check (engine in ('deterministic', 'vision')),
  severity            verdict_severity_enum not null,
  pass_threshold      jsonb not null default '{}'::jsonb,
  citation_url        text,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (check_id, version)
);
comment on table qa_rubric is 'Versioned creative-QA rubric (defect classes + roofing sub-rubric). Seeded in P2.';
create trigger qa_rubric_set_updated_at
  before update on qa_rubric for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Evidence: compliance findings (append-only; the regulatory audit record).
-- ---------------------------------------------------------------------------
create table compliance_finding (
  id              uuid primary key default gen_random_uuid(),
  pipeline_id     uuid not null references pipelines (id) on delete cascade,
  creative_id     uuid references creatives (id) on delete cascade,
  copy_variant_id uuid references copy_variants (id) on delete cascade,
  pass            smallint not null default 1,             -- 1 = visual pass, 2 = copy re-arm
  rule_id         text not null,
  rule_version    int not null,
  severity        verdict_severity_enum not null,
  verdict         compliance_verdict_enum not null,
  evidence        jsonb,                                   -- {quote, matched_pattern, bbox, model_rationale}
  required_edit   text,
  citation_url    text,                                    -- frozen at eval time
  checked_by      text not null default 'operator',
  checked_at      timestamptz not null default now(),
  -- Override audit (manager release of a hard block).
  overridden      boolean not null default false,
  overridden_by   text,
  override_reason text,
  overridden_at   timestamptz,
  created_at      timestamptz not null default now(),
  foreign key (rule_id, rule_version) references compliance_rule (rule_id, version),
  constraint compliance_finding_has_target
    check (creative_id is not null or copy_variant_id is not null),
  constraint compliance_finding_override_audited
    check (
      not overridden
      or (override_reason is not null and length(btrim(override_reason)) > 0
          and overridden_by is not null and overridden_at is not null)
    )
);
comment on table compliance_finding is 'Append-only compliance evidence. Override = new audited columns; original fail retained.';
create index compliance_finding_creative_idx on compliance_finding (creative_id, checked_at desc);
create index compliance_finding_copy_idx on compliance_finding (copy_variant_id);
create index compliance_finding_pipeline_idx on compliance_finding (pipeline_id);
-- "what is hard-blocking launch right now": failing, block-severity, not overridden.
create index compliance_finding_open_blocks_idx on compliance_finding (pipeline_id)
  where verdict = 'fail' and severity = 'critical' and overridden = false;

-- ---------------------------------------------------------------------------
-- Evidence: QA results (append-only; one row per re-render attempt).
-- ---------------------------------------------------------------------------
create table qa_result (
  id                uuid primary key default gen_random_uuid(),
  pipeline_id       uuid not null references pipelines (id) on delete cascade,
  creative_id       uuid not null references creatives (id) on delete cascade,
  attempt           int not null default 1,
  status            qa_status_enum not null,
  defects           jsonb not null default '[]'::jsonb,    -- [{defect_class, severity, note, bbox?}]
  brand_consistency jsonb,
  checks            jsonb not null default '[]'::jsonb,    -- deterministic check results
  model             text,
  checked_by        text not null default 'operator',
  created_at        timestamptz not null default now(),
  unique (creative_id, attempt)
);
comment on table qa_result is 'Append-only QA evidence; latest attempt drives creative_stage_state(creative_qa).';
create index qa_result_creative_idx on qa_result (creative_id, created_at desc);
create index qa_result_pipeline_idx on qa_result (pipeline_id);

-- ---------------------------------------------------------------------------
-- Evidence: per-placement spec checks (+ derived crops).
-- ---------------------------------------------------------------------------
create table spec_check (
  id                    uuid primary key default gen_random_uuid(),
  pipeline_id           uuid not null references pipelines (id) on delete cascade,
  creative_id           uuid not null references creatives (id) on delete cascade,
  platform              platform_enum not null,
  placement             placement_enum not null,
  ratio                 ratio,
  status                spec_status_enum not null,
  checks                jsonb not null default '{}'::jsonb, -- {dims, file_kb, safe_zone_ok, overlay_pct}
  derived_path_supabase text,
  derived_path_drive    text,
  created_at            timestamptz not null default now(),
  unique (creative_id, platform, placement)
);
comment on table spec_check is 'Per-placement spec-validation results + derived crops.';
create index spec_check_creative_idx on spec_check (creative_id);
create index spec_check_pipeline_idx on spec_check (pipeline_id);

-- RLS deny-all (service-role bypass) on every new table.
alter table compliance_rule     enable row level security;
alter table qa_rubric           enable row level security;
alter table compliance_finding  enable row level security;
alter table qa_result           enable row level security;
alter table spec_check          enable row level security;
