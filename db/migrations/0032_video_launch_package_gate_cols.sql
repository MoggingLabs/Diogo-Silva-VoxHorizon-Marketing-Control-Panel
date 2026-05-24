-- 0032_video_launch_package_gate_cols.sql
-- ----------------------------------------------------------------------------
-- Mirror the launch_handoff gate columns (added to launch_packages in 0022) onto
-- video_launch_packages, so the launch handler can stamp a VIDEO launch package
-- the same way it stamps an image one (approver + frozen preconditions + the
-- recorded Meta entity graph). Additive, forward-only.
-- ----------------------------------------------------------------------------
alter table video_launch_packages
  add column if not exists pipeline_id      uuid references pipelines (id) on delete set null,
  add column if not exists preconditions    jsonb not null default '{}'::jsonb,  -- {spec_pass,compliance_clear,copy_ge_3}
  add column if not exists approved_by       text,
  add column if not exists approved_at       timestamptz,
  add column if not exists meta_campaign_id  text,
  add column if not exists meta_entities     jsonb,
  add column if not exists launched_at       timestamptz;
create index if not exists video_launch_packages_pipeline_idx
  on video_launch_packages (pipeline_id) where pipeline_id is not null;
