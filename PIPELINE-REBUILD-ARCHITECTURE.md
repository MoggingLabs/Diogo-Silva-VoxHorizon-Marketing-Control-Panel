# Pipeline Rebuild — Architecture

The canonical 6-layer design for rebuilding the VoxHorizon image-ad pipeline from a 5-stage **renderer** into a 12-stage **ad producer** with QA + compliance as first-class, hard-gated, per-creative concerns. This is the design-of-record; `OPERATOR-BUILDOUT.md` carries the prior research + the issue/phase breakdown, and the GitHub epics (#306–313) carry the executable acceptance criteria. Grounded in three research waves and current best practice (orchestration, policy-as-code, human-in-the-loop, ad-platform integration).

## Scope & principles

- **Rebuild the core, keep the stack.** Next.js (App Router) + Supabase (Postgres/RLS/Realtime/Storage) + FastAPI worker + Hermes operator stay. We re-found the pipeline's data model, orchestration, agent layer, UX, and integrations; we reuse the approvals long-poll, the SSE realtime relay, and the idempotent render contract.
- **Code owns control flow; the agent owns judgment.** The 12 stages are a fixed, gated DAG — a _workflow_, not an autonomous agent. The operator never decides advancement and never clears a gate.
- **Per-creative, not per-pipeline.** QA, compliance, copy, and spec operate on each creative independently; the pipeline is a cursor over a rollup of per-creative state.
- **Exactly-once for side effects; never advance on a heuristic.** Idempotency keys + a transactional outbox + an explicit work-unit ledger replace the event-count advancement that let an all-failed generation reach `done`.
- **Hard gates are server-enforced.** Compliance + launch cannot be cleared by the agent; only an audited human action releases them.
- **Local-first, no live cloud until approved.** Migrations validate on a Supabase branch; Meta/GHL/Drive run in fake-integration mode for tests; go-live is a separate, approved step.

Target stages: `configuration → ideation → review → generation → creative_qa → compliance_review (HARD) → copy → spec_validation → variant_plan → finalize_assets → launch_handoff (HARD) → monitor → done` (+ `cancelled`).

---

## Layer 1 — Orchestration (the spine)

**Decision: a Postgres-native explicit state machine** (not Temporal/Inngest/DBOS). Rationale: keeps one source of truth on the Supabase DB the dashboard + RLS already read, zero new infra, fits a solo operator. DBOS (Postgres-backed durable execution) is the documented escape hatch if deterministic multi-step retries ever outgrow the relay.

**Two machines:**

- **Pipeline machine** — one `pipelines.status` cursor over the 12 stages. Transitions are guarded by pure predicates (mirroring today's `lib/pipeline/transitions.ts` `canAdvance`) and applied with compare-and-set (`UPDATE … WHERE id=$ AND status=$expected`) for optimistic concurrency.
- **Creative machine** — one row per `(creative_id, stage)` in `creative_stage_state` for `stage ∈ {creative_qa, compliance_review, copy, spec_validation}`. States: `pending → in_progress → {passed | failed | overridden | skipped}`. A `failed` compliance unit leaves only via an audited `override` (requires `override_note`) or `remediate`. Copy edits `rearm` a previously-`passed` compliance unit (two-pass).

**Rollup gate.** A per-creative stage advances the pipeline only when `pipeline_rollup_cleared(pipeline_id, stage)` is true: every picked, non-killed creative ∈ {passed, overridden, skipped}. One SQL function; the advance route and the UI gate both read it so they agree by construction.

**Work-unit ledger** (`pipeline_work_units`) replaces the count heuristic for AGENT_WORK stages (generation, finalize): closure = `no queued/running ∧ ≥1 done`. An all-error batch does **not** close as success.

**Exactly-once side effects.** A transactional outbox (`integration_outbox` written in the same txn as the state change) drained by a `SELECT … FOR UPDATE SKIP LOCKED` relay; consumers dedupe on a deterministic `idempotency_key` (`integration_event_inbox`). The irreversible Meta launch is an **orchestrated saga**: create-campaign → adset → ad, each PAUSED-first with its own idempotency key; compensation = delete/leave-paused, never stop-live-spend.

**Gate topology.** Human gates: brief, picks, review, QA sign-off, copy approval, variant plan, launch, monitor. Auto: generation→creative_qa, spec→variant_plan, finalize→launch. HARD (audited, never count-auto-advanced): compliance, launch. Loops are forward-only: per-creative failures isolate to their row (targeted re-render / re-copy); monitor spawns a _new_ pipeline (not a back-edge).

---

## Layer 2 — Data model

**Decision: keep the proven state-row + append-only-log backbone; extend it.** Lifecycle and gate-state stay on **separate axes**: `creatives.status` (draft→…→live→killed) is the lifecycle the launch route + `0015` read; QA/compliance verdicts live in `creative_stage_state` + append-only evidence tables. Never overload.

**New / changed entities:**

- `creative_stage_state` — per-creative gate state (`unique(creative_id, stage)`, `CHECK` requiring `override_note` when `status='overridden'`).
- `pipeline_work_units` — the AGENT_WORK closure ledger.
- `integration_outbox` + `integration_event_inbox` — exactly-once side effects.
- `compliance_rule` (**lookup table, not an enum** — Meta/FTC policy churns) + `compliance_finding` (append-only, tamper-evident: `rule_id` + `version`, severity, evidence, frozen citation, override audit). `qa_rubric` + `qa_result` (append-only, per attempt).
- `spec_check` (per placement, derived crops), `variant_plan` + `variant_plan_cell`, `ad_entity` (Meta campaign/adset/ad/creative map, PAUSED-first state), `cost_ledger`, `operator_dispatches`, `concepts`, `client_integrations` (client → GHL/Drive/Meta ids).
- **Rebuilt `copy_variants`** (empty today → drop+create): adds `platform`/`placement`/`description`/`variant_index`/`pattern`/`validation`/approval columns; `unique(creative_id, platform, variant_index)`.
- Extend `creatives` (qa/compliance gate cols off the lifecycle axis, finalize/Drive cols), `launch_packages` (status enum + gate cols + pipeline link), `campaign_perf_image` (pipeline + ad_entity link).

**Enums:** `pipeline_status_enum` +8 stages; new `creative_stage_enum`, `stage_state_enum`, qa/compliance/spec/copy/launch status, severity, platform/placement, `ad_entity_*`; `iteration_author` +`operator`; `ratio` +`4x5`/`1.91x1`. `ALTER TYPE ADD VALUE` is forward-only, one per migration file.

**RLS/realtime/types:** every new table is RLS deny-all (service-role only, per `0011`); dashboard-visible state tables join `supabase_realtime` (evidence/log tables stay on-demand); regenerate `lib/supabase/types.gen.ts` after each migration and derive the hand-rolled `lib/pipeline/types.ts` unions from it.

---

## Layer 3 — Compliance + QA (the priority)

**Decision: policy-as-code with a deterministic + LLM-classifier split and worker-owned adjudication.** Mirrors how Meta itself runs ad review (automation + human).

- **Rules** are versioned data in `compliance_rule` (`rule_id`, `applies_to_vertical`, `surface`, `severity`, `engine ∈ {deterministic, llm, both}`, `check_spec` JSON-rule DSL, `required_edit`, `citation_url`). Authored as a seeded SQL fixture, reviewable in git.
- **Engine.** The worker runs deterministic checks (regex/field-predicate backstops, OCR text-area, Pillow resolution/legibility). The operator submits **candidate** findings for `llm`/`both` rules (`{label, confidence, evidence_span}`). The **worker adjudicates** and writes the verdict — the operator has no pass-writing tool. `uncertain` or low-confidence ⇒ escalate to the manager queue, never auto-pass.
- **Hard block.** The advance route refuses to leave `compliance_review` while any creative is `failed` without an audited `override`. Compliance + launch never use the count-heuristic auto-advance.
- **Override.** A manager-authed route writes `overridden` + a required `override_note`; the original `failed` finding is retained (append-only). Overrides are **void-on-content-change**: editing copy re-arms that creative's compliance unit.
- **QA rubric** (`qa_rubric`) scores per defect class (hands, in-image text, anatomy, surface) + a roofing detail sub-rubric, plus deterministic resolution/legibility/brand checks. Failures route to a targeted re-render; one failed creative never blocks the others.
- **Golden-set evals** gate every rule/prompt change in CI: the fixed "embarrassed by your bathroom" pair (P0.5) must FAIL `meta.personal_attributes` on the old line and PASS the new one; a defective roofing image must FAIL QA.

Starter ruleset: Meta personal-attributes, before/after by vertical (banned for health/cosmetic, allowed for property), FTC substantiation / guarantee-disclosure / unqualified-superlative, Meta financial special-ad-category, Google overlay-text, and per-client `client_offer_constraints` (do-not-say) synthesized at eval time.

---

## Layer 4 — Agent / operator

**Decision: a deterministic workflow (code) drives one orchestrator operator per stage, which delegates the four judgment stages to specialist sub-agents.** The donor `hermes-agent-ekko` already runs this orchestrator+specialist pattern (`SUBAGENT-POLICY.md` + `templates/subagents/*`).

- **Control flow is the workflow's**, not the agent's. The operator is dispatched per stage; it reads state, does the stage's work (in-context for mechanical stages; via a specialist for copy/qa/compliance/monitor), persists results, signals, and stops.
- **Per-creative execution:** one dispatch per stage loops all outstanding creatives in one turn, persists an array, and resumes by skip-done (the existing render idempotency contract, generalized). Cap creatives-per-dispatch to respect the 60-turn budget; keep deterministic work worker-side.
- **Typed dispatch envelope** (`{pipeline_id, stage, dispatch_id, expected_status}`): the operator asserts `status == expected_status` and stops on mismatch (kills stale/duplicate dispatch races).
- **Completion/health:** a new `pipeline_operator_signal` tool + `operator_dispatches` tracking + heartbeat to `/work/hermes/webhook`; a watchdog re-dispatches a stuck stage (today dispatch is blind fire-and-forget).
- **Skills:** rebuilt `pipeline-operator` playbook (8 new `## Stage:` sections) + new `copy-authoring`, `creative-qa`, `ad-compliance`, `campaign-launch`, `campaign-monitor`, enriched `image-ad-authoring`; each seeded from mapped Ekko donor assets, each with `evals/`.
- **Gate enforcement:** the agent has **no tool that writes a pass or clears a gate**. New MCP tools (`pipeline_operator_{qa_result, compliance_result, copy, spec_result, finalize_result, launch, monitor_result, signal}`) are typed/validated/idempotent and allowlisted in `policy.operator.yaml` — **except** `pipeline_operator_launch`/Meta-activate, which require approval; shell stays blocklisted.
- **Deploy:** a repo→`/docker/hermes-operator/data` one-way sync (rsync as uid-10000, diff-then-approve, post-deploy policy assertion, drift watchdog) closes today's manual-drift gap.

---

## Layer 5 — Dashboard UX

**Decision: the frontend is the projection of the per-creative data model.** Strangler-fig migration so live pipelines never break.

- **5-phase clustered stepper** (Define / Create / Vet / Pack / Live) replaces the flat per-status switch; a phase router maps every legacy status to a phase. Exhaustive `Record<PipelineStatus>` types make every sync-point omission a compile error.
- **`CreativeReviewGrid`** — creatives as rows; qa/compliance/copy/spec as columns of sub-state pills; batch + per-item actions; locked cells encode the forced ordering. The orphaned `SidePanel` is promoted to a tabbed **Review Drawer** (drill-in per creative).
- **CopyComposer** — author/edit/approve ≥3 variants/creative with per-platform live char counters, humanizer toggle, winning-copy-registry suggestions. (First in-pipeline copy authoring; `copy_variants` is wired here.)
- **ComplianceOverrideGate** — hard block + per-creative override with required justification + type-to-confirm + permanent audit display (reuses `ApprovalModal`/`ApprovalAuditTrail`).
- **LaunchGate** — preconditions checklist (spec-pass ∧ compliance-clear ∧ ≥3 copy approved) + PAUSED-first confirm; re-surfaces overrides.
- **MonitorDashboard** — KPI cards with threshold pills, a permanent GHL-truth banner, kill/scale verdicts.
- **Realtime:** add a `creative_stage_state` subscription to `PipelineDetailRealtime`; extend ASK/AUTO/HALT approval-mode to per-creative autonomy (hard gates never auto).

---

## Layer 6 — Integrations & infra

**Decision (per owner):** Meta + Drive are **operator-held MCP**; the worker is the recorder. The hard launch gate is enforced via the approvals plugin (the Meta _activate_ tool name goes in `extra_requires_approval`, long-polling the dashboard); PAUSED-first. Accepted residual: no server-side budget cap before spend — mitigated by the approval gate + preconditions.

- **Meta/Drive recorder endpoints** record the `ad_entity` graph + `drive_url` (md5-verified) idempotently after the operator's MCP calls.
- **GHL connector** (net-new, `worker/src/services/ghl.py`): read-only lead pull + `POST /work/ghl/webhook` ingest (deduped via the inbox) + a daily reconciliation poll; `client_integrations` maps client → GHL location. **Real CPL = Meta spend ÷ GHL leads** (GHL is lead truth, never Meta).
- **Cost ledger** unifies Kie/codex generation + Meta spend (from operator-pulled insights); powers budget queries.
- **Resilient HTTP base** (`worker/src/services/_http.py`): retries + jitter, circuit breaker, correlation-id logging — used by the GHL connector.
- **Observability:** correlation-id (`pipeline_id`) on all logs/integration calls; `/work/metrics` (outbox depth, breaker state, dispatch in-flight, cost vs cap); stuck-stage + outbox watchdogs; Slack ops alerts distinct from approval prompts.

---

## Cross-layer decisions

1. Orchestration = Postgres-native (no new workflow engine).
2. Meta/GHL/Drive = operator-MCP + worker-recorder (owner decision); GHL connector is the one net-new server service (read-only).
3. Compliance rules = lookup table (versioned), not enum.
4. Agent = orchestrator + specialist sub-agents; code owns control flow.
5. Lifecycle vs gate-state on separate axes; verdicts append-only + tamper-evident.
6. Strangler-fig everywhere; the 4 live pipelines (mostly inert) never regress.

## Migration order (forward-only)

`0015` (already in repo, matches live) → `0016` status enum +8 → `0017` other enums → `0018` qa/compliance/spec tables + rule/rubric lookups → `0019` creatives gate+finalize cols → `0020` copy_variants rebuild → `0021` variant_plan tables → `0022` launch_packages gate + ad_entity → `0023` perf link + cost_ledger + work_units + outbox/inbox + operator_dispatches + client_integrations + concepts → `0024` trigger redesign (reroute generation→creative_qa, re-home the `0015` auto-approve to post-compliance, auto-stage triggers, outbox relay). Each: RLS deny-all + selective realtime + regen types.

## Testing & Definition of Done

Every change ships with tests at **>90% coverage** (web vitest `test:coverage`; worker `pytest --cov=src --cov-fail-under=90`). Endpoint contract tests (happy/401/422/idempotency/error). State-machine unit tests with explicit **no-stall** assertions (all-failed generation does not advance; hard block holds; partial per-creative stage holds the gate; last creative opens it). A workflow e2e in fake-integration mode drives all 12 stages and asserts ordered advancement to `done`. Backend↔frontend wiring is verified (worker/route write → rendered stage → realtime refresh). See the GitHub epics for per-issue acceptance criteria.
