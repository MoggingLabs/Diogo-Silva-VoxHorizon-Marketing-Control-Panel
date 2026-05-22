# Operator Build-Out Roadmap

**Initiative:** Turn `hermes-agent-operator` from an image _renderer_ into a full image-ad _producer_ that delivers launch-ready creative at every stage.
**Issue series:** `OP-` · **Milestones:** `OP0 → OP4` · **Status:** scope draft, pending approval.
**Owner:** Diogo (manager / approver). The Operator does the work; the manager gates.

> Read order: §1 goal → §2 current state → §3 target pipeline → §6 phases → §7 GitHub tracking. §4 (ad anatomy) and §5 (donor map) are the reference substance the build draws on.

---

## 1. Goal & guiding decisions

**Goal:** every pipeline stage produces the best possible result, and the pipeline covers everything a finished ad needs _before launch_ — not just rendered images.

**Locked decisions (this initiative):**

- **Compliance is a HARD GATE with manager override.** The Operator may not pass a creative/copy that fails a Meta/FTC check; only an explicit manager override releases it.
- **Roadmap-first.** This document is the scope. No skill/SOP/code is written until the scope here is approved.
- **Repo is source of truth.** All work is built in this repo (`ekko-skills/`, `ekko-plugins/`, `worker/`, `web/`, `db/`) and tracked on GitHub. Local-first; no live deploy until explicitly approved.
- **Human-in-the-loop preserved.** Every new stage keeps the "Operator works → stops → manager approves" model. New stages add gates, they don't remove them.
- **No AI attribution** in any commit/PR/issue body (house rule).

**Core reframe:** the Operator _regressed away from VoxHorizon's own SOPs_. Six needed stages (copy, compliance, QA, asset finalization, launch gate, monitoring) are already documented in Ekko's VPS SOPs and were never carried into the automated pipeline. Much of this work is **porting + hardening**, not inventing.

---

## 2. Current state (baseline)

### Where things live

| Thing                  | Path                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| Operator runtime (VPS) | `/docker/hermes-operator/data/` (skills, plugins, config.yaml, SOUL.md)                         |
| Ekko mgr runtime (VPS) | `/docker/hermes-agent-t4k4/data/` (container `hermes-agent-ekko`) — the donor                   |
| Repo source of truth   | `ekko-skills/`, `ekko-plugins/`, `worker/`, `app/`+`components/`+`lib/` (web), `db/migrations/` |
| Image-ad SOPs (VPS)    | `/docker/hermes-agent-t4k4/data/workspace/docs/image-ad-production-sop.md` (+ `-workflow.md`)   |

### Operator today

- **Skills:** `image-ad-authoring` (pure prompt/brief craft) + `pipeline-operator` (loop + render). Repo == deployed (byte-identical modulo line endings).
- **Render:** free `gpt-image-2` via the manager's Codex OAuth ($0), in-container, T2I only. Ideation = 1:1 @1K LOW; finals = 1:1 + 9:16 @2K HIGH.
- **Plugin:** `voxhorizon-approvals` (pre_tool_call gate). Render is currently _allowlisted_ (per-render spend gate removed live).
- **Empty:** `memories/`, `hooks/`, `cron/`, `plans/`. No persistent knowledge, no copy, no QA, no compliance, no launch path.

### Pipeline today

`configuration → ideation → review → generation → done`

- DB enum `pipeline_status_enum` (`db/migrations/0006_pipelines.sql`); Python `PipelineStage` (`worker/src/services/pipeline_runner.py`); TS unions (`lib/pipeline/types.ts`).
- MCP tools (worker): `read`, `client_read`, `brief`, `render`, `store_creative` (`worker/src/routes/pipeline_tools.py`).
- `generation → done` auto-advances via DB trigger (`0007` + `0014` fix). Outputs naked PNGs — no copy, no compliance, no Drive, no launch.

---

## 3. Target pipeline

New stages in **bold**. Model stays "Operator works, manager gates."

| #   | Stage                    | Purpose                                                                                                                           | Output                                | Gate                              |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------- |
| 1   | configuration _(deepen)_ | Author brief + N concept specs, using angles library + per-client constraints                                                     | brief + concepts                      | approve brief                     |
| 2   | ideation _(deepen)_      | Render N concept previews; apply contractor-realism prompt craft                                                                  | previews                              | spend/picks                       |
| 3   | review _(deepen)_        | Manager picks; Operator adds a scored recommendation                                                                              | picks                                 | picks                             |
| 4   | generation _(deepen)_    | Render finals (add 4:5 alongside 1:1/9:16)                                                                                        | finals                                | —                                 |
| 5   | **creative_qa** ⟳        | AI-defect + brand-consistency vision check vs client profile                                                                      | pass/fail + notes; re-render loop     | manager QA sign-off               |
| 6   | **compliance_review** ⟳  | Meta + FTC screen, vertical-aware (personal-attributes, before/after, claims). Two-pass: visual first, re-armed when copy changes | verdict + required edits              | **HARD BLOCK + manager override** |
| 7   | **copy** ⟳               | headline + primary text + CTA + description per visual (3 each), owner voice, humanized                                           | copy_variants                         | approve copy                      |
| 8   | **spec_validation** ⟳    | per-placement ratios/file/safe-zones (Meta 1:1+4:5+9:16; Google overlay-free)                                                     | spec report; derived crops            | auto, exceptions surfaced         |
| 9   | **variant_plan**         | A/B matrix (creative × copy × audience), one variable at a time                                                                   | test matrix                           | approve test plan                 |
| 10  | **finalize_assets**      | naming convention + registry + Drive upload + verify                                                                              | named/versioned Drive assets          | auto + verify report              |
| 11  | **launch_handoff**       | assemble + validate package; on approval push to Meta                                                                             | launch package + live/queued entities | **HARD launch gate**              |
| 12  | **monitor**              | CPL/CTR/fatigue thresholds (GHL = lead truth) → feed next brief                                                                   | verdicts + next-brief input           | approve kill/scale                |

⟳ = **per-creative** stage (operates on each picked creative independently, not the pipeline as a whole — see §3a). Forced ordering: copy must be checked by compliance (compliance is two-pass: visual gate before copy, then re-armed by copy edits); spec_validation needs the final copy because text drives safe-zones/overlay; launch needs ≥3 approved copy variants per creative.

Each new stage touches ~9 sync points (not 6): DB enum `pipeline_status_enum` → Python `PipelineStage` (`worker/.../pipeline_runner.py`) → **two** TS unions (`lib/pipeline/types.ts` AND `lib/pipeline/schemas.ts`) → the `Record<PipelineStatus,…>` label/badge maps + `page.tsx` placeholder map + stepper `PIPELINE_STAGES` → advance/decision route → operator instruction (`lib/operator/dispatch.ts`) → (maybe) new MCP tool + auto-advance trigger → regenerate `lib/supabase/types.gen.ts`.

---

## 3a. Pipeline architecture accommodation (the structural change)

Adding the stages is not just "8 more enum values." Copy, QA, and compliance operate **per-creative**, but the pipeline today advances as a single per-pipeline `status`. This section is the spine the per-stage work hangs on. (Derived from the dedicated architecture + data-model + worker + UX accommodation passes.)

### Per-creative state model — the decisive call

Keep the single per-pipeline `status` as the macro cursor (cheapest, preserves the whole UI/route/trigger machinery). Add a **`creative_stage_state` side table** for the per-creative stages:

```
creative_stage_state(
  id, pipeline_id→pipelines, creative_id→creatives,
  stage   ∈ {creative_qa, compliance_review, copy, spec_validation},
  status  ∈ {pending, in_progress, passed, failed, overridden, skipped},
  verdict jsonb,            -- QA notes / compliance findings+required_edits / spec report
  decided_by, override_note,-- override_note REQUIRED when status='overridden' (compliance audit)
  decided_at, created_at, updated_at,
  unique(creative_id, stage)
)
```

- A per-creative stage is "done for the pipeline" when **every picked, non-killed creative** is `passed | overridden | skipped`. That rollup is the human "Continue" gate predicate.
- One failed creative does NOT block the others — it routes to a targeted loop (below); the pipeline status simply can't advance until the rollup clears or the creative is dropped from `picks`.
- Rejected: full derived-status model (rewrites the entire UI/route/trigger spine) and a checklist mega-stage (hides the compliance hard gate). Side table is the minimal change for true per-creative independence.
- Do **not** overload `creatives.status` (`draft→approved→live→killed`) — that lifecycle axis is read by the launch route and the `0015` auto-approve; keep QA/compliance verdicts orthogonal in the side table.

### The trigger reroute (highest-risk change)

- The `generation → done` auto-advance trigger (`0007`→`0014`) must repoint to **`generation → creative_qa`** and seed `creative_stage_state` rows for each final. The closure heuristic stays.
- **`0015` auto-approve must move** from generation-close to **post-compliance** (finalize/launch). Otherwise finals become `approved` before QA/compliance run, defeating the hard gate.
- Add analogous auto-advance triggers for the two auto stages (spec_validation→variant_plan, finalize_assets→launch_handoff), reusing the `greatest(queued,running)` dual-path heuristic. Compliance and launch must **never** use count-heuristic auto-advance.

### ⚠️ Migration `0015` drift — must fix FIRST

`0015_operator_launch_approval` is **applied to the live DB** (function `approve_operator_pipeline_outputs` confirmed present) but exists **only in a worktree branch**, not in `db/migrations/`. Any trigger edit from the repo's `0014` baseline will silently delete the operator auto-approve and re-break operator launches. **Promote 0015 into `db/migrations/` before any other migration.** The OP migration sequence then runs 0016+.

### Per-creative execution model (operator side)

One dispatch per **stage**, not per creative: the operator reads state once, loops every outstanding creative _inside one turn_, persists all of them in one tool call (array payload), and a re-dispatch resumes by skipping creatives already done — the same idempotent pattern as the deterministic render. Strain to watch: the operator's 40-turn budget under per-creative loops at high N; keep deterministic work worker-side where possible.

### Drive / Meta / GHL are operator-MCP, not worker services

finalize_assets (Drive), launch_handoff (Meta), and monitor (Meta + GHL) run through **operator-held claude.ai MCP tools**; the worker is the **recorder** of operator-supplied results (Drive URLs, Meta entity ids, insights), not the API caller. **GHL — the lead source of truth for monitor — has no integration anywhere yet** (a net-new connector, or operator-manual). PAUSED-first for all Meta writes.

### Migration sequence (forward-only; each `ALTER TYPE ADD VALUE` in its own file)

`0015 promote` → `0016` pipeline_status_enum +8 stages → `0017` new enums (iteration_author +operator; ratio +4x5/+1.91x1; qa/compliance/spec/copy/launch status enums) → `0018` qa/compliance/spec tables + RLS + realtime → `0019` creatives gate+finalize columns → `0020` copy_variants wiring (status→enum, +pipeline_id/description/platform/variant_index/validation/approval) → `0021` variant_plan tables → `0022` launch_packages gate (verify the 1 live row casts) → `0023` campaign_perf_image pipeline link → `0024` triggers redesign. New tables = RLS deny-all + add to `supabase_realtime`; regen `types.gen.ts` after each.

---

## 4. What an image ad must have (requirements the build enforces)

**Purpose:** local home-services lead-gen (roofing, remodeling encoded; HVAC/dental/med-spa/legal next). Success metric: leads → booked → showed → sold.

**Anatomy (the QA/compliance gates encode this):**

- **Offer is the ad.** Specific dollar number in headline; ≤6 words on-image; city localized; specific CTA. "Free Quote" for remodeling, "Free Estimate" for roofing.
- **Contractor-iPhone realism, not AI slop.** (16B-impression study: AI images win _only if they don't look AI_.) Native/"ugly" UGC for cold traffic; polished for retargeting.
- **Visual-defect QA:** hands/fingers/teeth/text/signage; roofing = visible shingle rows, granule texture, straight rooflines, real flashing, no melted surfaces.
- **Ratios:** Meta feed prefers **4:5 (1080×1350)** + 1:1; Stories/Reels 9:16 with safe zones (top ~14%, bottom ~20–35%). Google Display = overlay-free 1.91:1 + 1:1, ≤5MB, center-80% safe.
- **Compliance (vertical-aware, HARD GATE):**
  - Meta **Personal Attributes** — no "Are you embarrassed by…/Struggling with…" framing (any vertical). _Note: VoxHorizon's own `ad-copy-standards.md` currently recommends a violating hook — fix in OP0._
  - Before/after OK for roofing/remodel; **banned** for health/cosmetic/weight-loss.
  - FTC — "guarantee/warranty/lifetime/best/clinically proven" need substantiation/disclosure.
  - Financing offers — 18+, no payday/≤90-day, Financial Special Ad Category since 2025-01-21.

**Decision thresholds (monitor stage):** CTR <1% flag / >2% scale; frequency >3 fatigue; CPL 2× avg = kill; $75 spend / 0 leads = kill; hold ≥3–5 days or 1,000 impressions before declaring a winner. Real CPL = Meta spend ÷ **GHL** leads (GHL is the source of truth, never Meta). Tiebreaker on conflicting docs: `LEARNINGS.md` (1.5× kill) is operative.

---

## 5. Donor map — Ekko assets → Operator

| Ekko source (VPS)                                                            | Becomes Operator asset                                                | Serves stage    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------- |
| `templates/subagents/brief-writer.md`                                        | brief authoring logic                                                 | 1 configuration |
| `templates/subagents/competitor-researcher.md` + `competitor-radar` skill    | market/ideation input                                                 | 1–2             |
| `templates/subagents/copywriter.md` + `copywriting` skill                    | **copy** skill                                                        | 7 copy          |
| `templates/subagents/ad-auditor.md` + `campaign-audit` skill                 | **monitor** skill                                                     | 12 monitor      |
| `knowledge/winning-copy-registry.md` + `mignogna-ad-copy-vault*.md`          | queryable winning-copy registry                                       | 7 copy          |
| `docs/decision-thresholds.md` + `LEARNINGS.md`                               | thresholds rule engine                                                | 12 monitor      |
| `creative/humanizer/SKILL.md`                                                | mandatory de-AI-slop pass                                             | 7 copy / review |
| `client-profiles/*.json` + `client_offer_constraints`                        | per-client constraints config                                         | 1, 6, 7         |
| `image-ad-prompting/references/*` (kie, nano-banana, roofing QA, owner-edit) | realism prompt craft + roofing negative bank + **creative_qa** rubric | 2, 5            |
| `launch-gate` skill + `launch_package.py`                                    | **launch_handoff** + spec validation                                  | 8, 11           |
| `09/10/11/18/20` knowledge                                                   | angles library + ad-testing/graduation logic                          | 1, 9            |

---

## 6. Phased delivery plan

Sequenced so each phase is independently shippable and earlier phases de-risk later ones.

### OP0 — Foundation & correctness _(priority: critical)_

Fix what's actively wrong before adding capability.

- Rewrite stale Operator `SOUL.md` + `pipeline-operator/SKILL.md` + `README.md` to match reality (free `gpt-image-2` codex, no per-render gate). Remove `RENDER_BACKEND` doc/code drift.
- Scrub retired `nano-banana-pro` from the 3 SOP docs; pin the real GPT Image 2 model string.
- Fix the Meta-policy-violating hook in `ad-copy-standards.md` ("embarrassed by your bathroom").
- Verify the `voxhorizon-approvals` plugin env wiring on the Operator (`VOXHORIZON_APPROVAL_WORKER_URL/TOKEN`) — confirm the gate is actually live, not bypassed/fail-closed-blocking.
- De-duplicate the finals-model registry (`operator/route.ts` ↔ `pipeline-operator/helper.py`).
- Author the **image-specific visual-quality rubric** that today only exists for video.
- Decide + document the **repo → Operator deploy/sync mechanism** (deploy-stack only rolls web/worker; Operator `/docker/hermes-operator/data` is manual today).

### OP1 — Expertise layer (deepen existing 5 stages) _(priority: high)_

Make the _current_ pipeline produce better ads before adding stages.

- Angles library (niche → ranked angles + example hooks/headlines + proven CPL).
- Queryable winning-copy registry + Mignogna swipe templates.
- Per-client constraints config (offers, do-not-say, voice, shared-account warnings e.g. Dinero/Aquarium).
- Enrich `image-ad-authoring`: contractor-iPhone realism, roofing negative bank, identity-preservation cues.
- Add concept scoring to the review stage (Operator recommends picks).

### OPA — Pipeline state-model & trigger foundation _(priority: critical — prerequisite for OP2+)_

The structural change (§3a) that lets per-creative stages exist. Must land before any OP2 stage.

- Promote migration `0015` into `db/migrations/` (reconcile live/repo drift) **first**.
- `creative_stage_state` per-creative table + rollup-gate helpers (advance when all picked creatives clear).
- Enum + sync-point scaffolding: add the 8 stages across all ~9 sync points + regenerate `types.gen.ts`.
- Reroute the `generation` auto-advance (→ `creative_qa`); re-home the `0015` auto-approve to post-compliance; add auto-advance triggers for the auto stages.
- `ratio` enum +`4x5`/+`1.91x1` and add Pillow (for spec-stage derived crops).

### OP2 — Launch-readiness core: QA + Compliance + Copy _(priority: critical)_

The stages that turn images into shippable ads. Builds on OPA.

- DB: qa/compliance verdict tables + **full `copy_variants` wiring** (status enum, `platform`/`placement`, `description` field, `variant_index`, `pattern`, `validation` jsonb, approval cols, pipeline link). Table is empty now — migrate before it has data.
- **creative_qa** stage — multimodal defect + brand-consistency check; per-creative re-render loop.
- **compliance_review** stage — **HARD BLOCK + manager override** (audited, per-creative, written justification); two-pass (visual + copy re-arm); vertical-aware Meta+FTC ruleset; enforces `offer_constraints`.
- **copy** stage — `ad-copy-authoring` skill + MCP tool + the first in-pipeline copy-editor UI (3 headlines/body/desc/CTA per creative, char counters, humanizer toggle) + tighten launch validator from ≥1 to **≥3** approved variants per creative.

### OP3 — Specs, finalization, launch _(priority: high)_

Note: finalize (Drive), launch (Meta) run through **operator-held MCP tools**; worker is the recorder. PAUSED-first for Meta.

- **spec_validation** — ratios incl. 4:5, file/size, safe zones; Meta + Google overlay-free variants; derived crops.
- **finalize_assets** — naming convention + registry + Drive upload + verify (reconcile the two Drive taxonomies).
- **launch_handoff** — package + validate + Meta upload (Meta MCP tools); **HARD launch gate** (preconditions checklist: spec-pass + compliance-clear + copy-approved).

### OP4 — Testing & feedback loop _(priority: medium)_

Note: monitor needs Meta insights (operator MCP) **and GHL leads — GHL has no integration yet** (net-new connector or operator-manual).

- **variant_plan** — A/B matrix, one variable at a time.
- **monitor** — thresholds engine (GHL truth) → verdicts → feed next brief; close the loop.

---

## 7. GitHub tracking structure

**New labels:** `phase: OP0-foundation`, `phase: OP1-expertise`, `phase: OPA-architecture`, `phase: OP2-launch-ready`, `phase: OP3-specs-launch`, `phase: OP4-loop`. (Reuse existing `area:*`, `type:*`, `priority:*`.)

**New milestones:** OP0, OP1, OPA, OP2, OP3, OP4 (titles below; OPA runs before OP2). Each issue uses the `OP-` prefix and carries area/type/priority/phase labels + a task-checklist body (sub-issues). Note: issue numbers track creation order, not execution order (OPA's higher numbers run before OP2's), matching the existing `HI-` convention.

### OP0 — Foundation & correctness

- `OP-1` Rewrite Operator SOUL.md + pipeline-operator SKILL/README to match live render reality `area: agent, area: docs, priority: critical`
- `OP-2` Scrub retired `nano-banana-pro`; pin GPT Image 2 model string across SOPs `area: docs, priority: high`
- `OP-3` Fix Meta-policy-violating hook in ad-copy-standards `area: docs, priority: high`
- `OP-4` Verify voxhorizon-approvals env wiring on Operator (gate live?) `area: agent, area: infra, priority: critical, type: research`
- `OP-5` De-duplicate finals-model registry (route.ts ↔ helper.py) `area: backend, area: agent, priority: medium`
- `OP-6` Author image-specific visual-quality rubric `area: docs, area: agent, priority: high`
- `OP-7` Decide + document repo→Operator deploy/sync mechanism `area: infra, type: research, priority: high`

### OP1 — Expertise layer

- `OP-8` Angles library asset `area: agent, priority: high`
- `OP-9` Queryable winning-copy registry (+ Mignogna templates) `area: agent, priority: high`
- `OP-10` Per-client constraints config `area: agent, area: integration, priority: high`
- `OP-11` Enrich image-ad-authoring: realism + roofing negatives + identity cues `area: agent, priority: high`
- `OP-12` Review-stage concept scoring/recommendation `area: agent, area: backend, priority: medium`

### OPA — Pipeline architecture foundation _(runs before OP2)_

- `OP-23` Promote migration `0015` into `db/migrations/` (live/repo drift) `area: database, priority: critical`
- `OP-24` `creative_stage_state` per-creative table + rollup-gate helpers `area: database, area: backend, priority: critical`
- `OP-25` Enum + 9-sync-point scaffolding for all 8 stages + regen `types.gen.ts` `area: database, area: backend, area: frontend, priority: critical`
- `OP-26` Reroute generation auto-advance (→creative_qa); re-home `0015` auto-approve post-compliance; add auto-stage triggers `area: database, priority: critical`
- `OP-27` `ratio` enum +`4x5`/+`1.91x1` + add Pillow for derived crops `area: database, area: backend, priority: medium`

### OP2 — Launch-readiness core

- `OP-13` DB: qa/compliance verdict tables + full `copy_variants` wiring (status enum, platform/placement, description, variant_index, pattern, validation, approval cols, pipeline link) `area: database, priority: critical`
- `OP-14` creative_qa stage: skill + MCP tool + UI + re-render loop `area: agent, area: backend, area: frontend, priority: high`
- `OP-15` compliance_review stage: HARD GATE + override; Meta/FTC vertical-aware ruleset `area: agent, area: backend, area: frontend, priority: critical`
- `OP-16` copy stage: skill + MCP tool + humanizer `area: agent, priority: critical`
- `OP-17` copy UI + wire `copy_variants` into pipeline `area: frontend, area: backend, priority: high`

### OP3 — Specs, finalization, launch

- `OP-18` spec_validation stage (Meta+Google specs, 4:5, safe zones) `area: backend, area: agent, priority: high`
- `OP-19` finalize_assets: naming + registry + Drive `area: integration, area: agent, priority: high`
- `OP-20` launch_handoff: package + validate + Meta upload + HARD gate `area: integration, area: backend, area: agent, priority: critical`

### OP4 — Testing & loop

- `OP-21` variant_plan stage (A/B matrix) `area: agent, area: backend, priority: medium`
- `OP-22` monitor stage: thresholds engine (GHL truth) + feedback to brief `area: integration, area: agent, priority: medium`

Cross-cutting umbrella issue: `OP-0` "Operator build-out — tracking issue" linking all milestones (mirrors the HI- master-tracker pattern).

---

## 8. Cross-cutting risks & fixes (carried as checklist items)

- **Deploy gap:** no auto-sync repo → `/docker/hermes-operator/data`. Every Operator change needs a deliberate copy step (go-live, requires approval).
- **Approvals gate uncertainty:** required env vars not in Operator `.env` on disk — gate may be bypassed or fail-closed. (`OP-4`)
- **Auto-advance is a count heuristic** (`done+error ≥ greatest(queued,running)`): an all-failed generation still advances to done. Revisit when inserting QA before done.
- **Authorship lossy:** operator creatives stored as `author='ekko'` (enum lacks `operator`). Add enum value if analytics need to distinguish.
- **Registry duplication** must stay in lockstep or renders route to the wrong (paid) backend.
- **Two Drive taxonomies** (image flat vs video numbered) need reconciling in `finalize_assets`.
- **0015 operator-launch-approval migration** exists only in a worktree branch — confirm intent before OP3.

---

## 9. Open assumptions

- New skills built in `ekko-skills/` (Operator-owned ones); shared craft may also land in Ekko. Deploy to both agents decided per-skill.
- Meta upload uses the existing Meta MCP tools; PAUSED-first staging per Ekko's `launch-gate` safety rules.
- Phases ship in order, but OP0 + OP1 can overlap (docs vs assets).
