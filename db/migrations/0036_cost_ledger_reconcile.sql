-- 0036_cost_ledger_reconcile.sql
-- M4 cost integrity (#498 E4.1 ledger / #501 E4.2 pricing / #503 E4.3 wire cost).
--
-- The worker had two disconnected cost systems: emit_cost() wrote only
-- pipeline_events (the path prod actually calls) while cost_ledger.record_*()
-- wrote the cost_ledger table but had zero prod callers. reconcile_pipeline
-- reads cost_ledger for meta_spend, so real_cpl was structurally 0/None and the
-- monitor's kill/keep/scale decision ran on garbage. E4.3 makes emit_cost the
-- single write path that also lands a typed cost_ledger row, so this migration
-- closes the two schema gaps that change exposes:
--
--   1. The video voiceover stage records a TTS spend line. cost_kind_enum
--      (migration 0017) had image_gen / video_gen / vision_qa / copy_llm /
--      meta_spend / other but no value for text-to-speech, so a TTS row would
--      fall back to 'other' and lose its category in the budget gauge. Add a
--      first-class 'tts' value (forward-only; ALTER TYPE ... ADD VALUE cannot
--      run inside a value-using txn, so it lives alone here ahead of any use).
--
--   2. cost_ledger gained no idempotency key, so a retried render (the operator
--      replays a stuck stage) or a re-run reconciliation would double-count
--      spend. Add a nullable dedupe_key + a partial UNIQUE index so a caller
--      that supplies a key gets exactly-once accounting while legacy keyless
--      rows still insert freely.
--
-- Additive, idempotent, forward-only. Migration numbers 0034/0035 are reserved
-- for M1 (neutral creative identity); this is the next free number.

-- ---------------------------------------------------------------------------
-- 1. Add 'tts' to cost_kind_enum (forward-only; not referenced in this txn).
-- ---------------------------------------------------------------------------
alter type cost_kind_enum add value if not exists 'tts';

-- ---------------------------------------------------------------------------
-- 2. cost_ledger idempotency: a dedupe_key + partial UNIQUE so a caller that
--    supplies one gets exactly-once spend accounting. NULL keys are exempt
--    (legacy / un-keyed rows still insert), so this is backward-compatible.
-- ---------------------------------------------------------------------------
alter table cost_ledger
  add column if not exists dedupe_key text;

create unique index if not exists cost_ledger_dedupe_key_uniq
  on cost_ledger (dedupe_key)
  where dedupe_key is not null;
