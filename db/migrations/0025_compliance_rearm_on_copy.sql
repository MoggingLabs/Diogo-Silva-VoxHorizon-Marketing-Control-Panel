-- 0025_compliance_rearm_on_copy.sql
-- Two-pass compliance re-arm (P2.7, #345).
--
-- Overrides are VOID-ON-CONTENT-CHANGE: a manager may release a compliance
-- block for a creative (creative_stage_state(compliance_review).status =
-- 'overridden'), but if the COPY for that creative is then edited the prior
-- adjudication no longer reflects the live copy, so the gate must re-arm. This
-- trigger fires whenever a copy_variants row for a creative is inserted or
-- updated and resets that creative's compliance_review gate back to 'pending'
-- (clearing the stale override audit fields), forcing a fresh worker
-- adjudication (the "two-pass" re-check).
--
-- Scope: only the affected creative's row is re-armed (one creative's copy edit
-- never disturbs another creative's gate). Only rows that are NOT already
-- 'pending' are touched, so the trigger is idempotent and a no-op when nothing
-- needs re-arming. RLS is unaffected (the trigger runs in the row's own txn;
-- creative_stage_state stays deny-all per 0011/0018).
--
-- Forward-only. Depends on: 0018 (creative_stage_state + creative_stage_enum),
-- 0020 (copy_variants.creative_id). The set_updated_at() helper already exists.

create or replace function compliance_rearm_on_copy_change()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
declare
  v_creative_id uuid;
begin
  -- NEW.creative_id is NOT NULL on copy_variants (0001), but guard anyway so a
  -- malformed write can never raise inside the trigger.
  v_creative_id := new.creative_id;
  if v_creative_id is null then
    return new;
  end if;

  -- Re-arm ONLY this creative's compliance unit, and only when it is not
  -- already pending (idempotent; avoids a redundant write + updated_at churn).
  -- Clearing the override audit fields makes the re-arm explicit: a re-armed
  -- unit carries no stale "overridden by / note / at" from the voided release.
  update creative_stage_state
     set status        = 'pending',
         override_note = null,
         decided_by    = null,
         decided_at    = null
   where creative_id = v_creative_id
     and stage = 'compliance_review'
     and status <> 'pending';

  return new;
end;
$$;

comment on function compliance_rearm_on_copy_change() is
  'Two-pass compliance re-arm (P2.7): a copy_variants insert/update resets that '
  'creative''s compliance_review gate to pending (void-on-content-change), '
  'clearing any stale override. Scoped to the one affected creative.';

-- AFTER so the copy write is committed to the row before the gate is re-armed;
-- per-row so a multi-row copy write re-arms each affected creative exactly once.
create trigger copy_variants_rearm_compliance
  after insert or update on copy_variants
  for each row execute function compliance_rearm_on_copy_change();
