# Video Pipeline Architecture (foundation map)

**Purpose:** Prove, layer by layer, that the video-ad pipeline is built on the
*existing, proven* foundation of the image pipeline rather than a pile of ports
or patches, and pin the few genuinely new decisions so they are made once, up
front. This is the sign-off artifact: approve the foundation here before more
code lands.

**Companion docs:** `VIDEO-BUILDOUT.md` (the PR sequence), `OPERATOR-BUILDOUT.md`
(the image build this mirrors), `PIPELINE-REBUILD-ARCHITECTURE.md` (the
per-creative state model + sync points), `db/SCHEMA.md` (the data spine).

**House rules:** no AI attribution in commits/PRs; no em dashes in agent-facing
files (SOUL/AGENTS/MEMORY/SKILL).

---

## 1. The principle: video is a *format*, not a new pipeline

The system was designed two-vertical from day one. `db/SCHEMA.md` section 0:
*"Two verticals, parallel tables. Image and video share `clients`, `pipelines`,
`events` ... everything else is split (`briefs`/`video_briefs`,
`creatives`/`video_creatives`, etc.) so each side can evolve column shapes."*
The `pipelines` row already carries `format_choice` (`image`|`video`|`both`) and
`video_brief_id`. So video does **not** add a pipeline, a stage model, a state
machine, a gate engine, or a dispatch loop. It reuses all of them and adds:

1. a **generation backend** (the only net-new infrastructure), and
2. a **format branch** at the points that are currently image-hardwired.

Everything below is checked against the real tree at `origin/main`.

---

## 2. Layer map (what exists, what is dormant, what is the gap)

Legend: **[BUILT]** on `origin/main` · **[PR]** built + tested, in an open PR,
dormant · **[GAP]** not yet built.

### Layer A - Data model  ·  [BUILT]
`db/migrations/0001_initial_schema.sql` (+0004 constraints) already define the
full video spine, and `db/SCHEMA.md` documents it:

| Table | Role | Key columns |
|---|---|---|
| `video_briefs` | inbound brief queue | `target_duration_s`, `voice_id`, `music_track`, `hook_style`, `dimensions` (ratio, default `9x16`), `captions_style`, `broll_selection_mode` (default **`review_each`**), `payload` jsonb, `status` (`video_brief_status`) |
| `video_creatives` | one row per generated video | `script_path`, `voiceover_path`, `broll_clips` jsonb (`{segment_idx, store_backend, clip_id, in_s, out_s, source_url}`), `composed_path`, `captioned_path`, `drive_url`, `duration_actual_s`, `status` (`video_creative_status`: draft -> script_ready -> voiceover_ready -> broll_ready -> composed -> captioned -> approved/rejected) |
| `video_iterations` | append-only audit trail | `kind` (`video_iteration_kind`), `content` jsonb |
| `video_copy_variants` | copy per creative | `headline`, `body`, `cta`, `humanized`, `status` |
| `video_launch_packages` | launch payload per brief | `status`, `payload` jsonb |
| `campaign_perf_video` | monitor KPIs | image KPIs **plus** `hook_rate`, `drop_off_3s`, `view_rate_avg`, `watch_time_p50` |

Nothing to build here. The shapes the generation layer writes (`script_path`,
`voiceover_path`, `broll_clips`, `composed_path`, `captioned_path`) already
exist as columns.

### Layer B - Control plane (12-stage gated DAG)  ·  [BUILT]
Video runs the **same** stages and the **same** per-creative
`creative_stage_state` model as image (migration `0018`):

```
configuration -> ideation -> review -> generation* -> creative_qa
  -> compliance_review (HARD) -> copy -> spec_validation -> variant_plan
  -> finalize_assets -> launch_handoff (HARD) -> monitor -> done
```

`worker/src/routes/pipeline.py` already drives the video track:
`_produce_ideation_video_track` (writes N script drafts via
`record_video_stage(stage='script')`), `_produce_generation_video_pick`, and the
substage loop `_run_generation_video_substages`. No new stages; video adds **0**
sync points to the 12-stage machine.

### Layer C - Generation substage chain  ·  dispatcher [BUILT], handlers [PR]+[GAP]
`pipeline.py` owns the chain and its contract (already on `main`):

```python
_VIDEO_SUBSTAGES = ("script","voiceover","broll_search","broll_pick","compose","caption")
# _run_video_substage(video_route, substage, creative) dispatches each to a
# video_route handler and reads back: script_path / voiceover_path / candidates
# / resolved / composed_path / captioned_path. Handlers raise HTTPException on
# failure; the loop emits task_queued/running/done/error + cost, and short-
# circuits the rest of one concept on failure. Cancellation polls before each
# substage. This control flow is DONE and correct.
```

`worker/src/routes/video.py` is a **deliberate stub** (HI-8 deleted ~25k LOC of
video service code): all six handlers `raise NotImplementedError`. The recovery
ref `381eb4a^` carries the original 958-line implementation as the contract.

The backend that the rewritten handlers call is the only net-new infrastructure,
and it is built + tested, dormant, in open PRs:

| Substage | Old backend (deleted) | New backend | Status |
|---|---|---|---|
| script | ClaudeRunner + skill | ClaudeRunner + `video-ad-authoring` skill | runner [BUILT]; skill [GAP] |
| voiceover | ElevenLabs SaaS | `services.kie_tts` (kie's ElevenLabs TTS) | [PR #408] |
| broll_search | yt-dlp | `services.broll_search` (yt-dlp) **+** `services.kie_video` (generated clips) | [PR #404/#405] |
| broll_pick | `broll_selection` | `services.broll_selection` (unchanged) | [PR #404] |
| compose | Hyperframes | `services.ffmpeg_compose` (local ffmpeg) | [PR #406] |
| caption | Submagic SaaS | `services.captions` (Whisper -> ASS -> ffmpeg) | [PR #407] |

Net cost ~$1.25 per ~24s ad (kie generation; $0 local compose/captions).

### Layer D - Persistence  ·  [BUILT]
`worker/src/services/atomic_inserts_video.py` `record_video_stage(...)` writes
`video_creatives` (insert/patch) + `video_iterations` + `events` atomically,
keyed by stage. `STAGE_STATUS` + `PATH_FIELDS` already map every substage to its
status bump and column. The handlers in Layer C only need to *call* it.

### Layer E - Operator surface (skill + helper + MCP + policy)
This is the repo's established skill architecture, identical across 10 skills
(`ekko-skills/*`): **`SKILL.md`** (the agent's judgment) + **`helper.py`** (pure,
unit-tested builders/validators, no I/O) + **`mcp_server.py`** (thin transport
publishing helpers as named MCP tools) + **`tests/`**. Video mirrors it:

| Piece | Image (template) | Video | Status |
|---|---|---|---|
| authoring skill | `ekko-skills/image-ad-authoring/` | `ekko-skills/video-ad-authoring/` | [GAP] |
| operator router | `ekko-skills/pipeline-operator/{SKILL,mcp_server,helper}.py` | extend same files | partial [GAP] |
| brief tool | `pipeline_operator_brief(image_payload, concepts)` | `pipeline_operator_video_brief(video_payload, concepts)` | [GAP] |
| render trigger | `pipeline_operator_render(kind, items)` | `pipeline_operator_video_render(...)` + `pipeline_operator_broll_select(...)` | [GAP] |
| spend policy | `ekko-plugins/voxhorizon_approvals/policy.operator.yaml` | add video tool names | [GAP] (see D1) |
| stage-persist | `qa_result`/`compliance_result`/`copy`/`spec_result`/`finalize_result`/`monitor_result`/`signal` | **reused as-is** (format-agnostic at the MCP layer) | [BUILT] |

### Layer F - Gated stages + format routing  ·  reused [BUILT], routing [GAP]
The gate machinery keys on `creative_id`, so the operator's persist tools
(qa/compliance/copy/spec/finalize/monitor/signal) and the dashboard gates are
reused unchanged. **But the worker side of several persist paths is currently
image-hardwired** - grep confirms `video_copy_variants`, `campaign_perf_video`,
and `video_launch_packages` are written **nowhere** in `worker/src`; only
`video_creatives` is. So format routing is the real downstream gap:

| Stage | Image target | Video target | Status |
|---|---|---|---|
| creative_qa | qa_result + backstops | + ffprobe/frame backstops, `verdict_video` | rubric [GAP] |
| compliance_review (HARD) | compliance candidates | + b-roll licensing, music rights, spoken-claim FTC | rubric [GAP] |
| copy | `copy_variants` | `video_copy_variants` | routing [GAP] |
| spec_validation | `spec_check` (Pillow) | ffprobe specs + crops + LUFS | routing [GAP] |
| finalize_assets | `creatives` finalize cols | `video_creatives.drive_url` | routing [GAP] |
| monitor | `campaign_perf_image` | `campaign_perf_video` (+ hook_rate etc.) | routing [GAP] |
| launch_handoff (HARD) | `launch_packages` -> Meta image ad | `video_launch_packages` -> Meta video ad | routing [GAP] |

---

## 3. Build status, in one view

- **Foundation (Layers A, B, D):** BUILT on `origin/main`. No work.
- **Generation backend (Layer C services):** BUILT + locally tested, dormant in PRs #404-#408.
- **The integration (Layer C handlers, VID-5):** rewrite `video.py`'s 6 handlers on the new stack. Depends on #404-#408 being merged first.
- **Operator surface (Layer E, VID-6/7):** GAP. Independent of the unmerged worker PRs - buildable now.
- **Gated-stage video routing + rubrics (Layer F, VID-9..12):** GAP. The largest remaining body of work.

---

## 4. Decisions to confirm (the genuinely new choices)

These are the only places video is not a pure mirror. Confirm them and the
foundation is settled.

### D1. Spend-gating model  ·  DECIDED: budget cap + over-threshold gate
`policy.operator.yaml` is explicit and load-bearing: image renders are **free
($0 codex) and allowlisted**; the **only** approval-gated tool is the
irreversible Meta launch; and the file *warns in comments* that re-adding a
per-render long-poll gate is "the footgun" (it was removed live on the VPS so the
operator does not pester the manager on every render). **Video render is
different: it spends real kie money.** `VIDEO-BUILDOUT.md` section 5's blanket
"gate `video_render`" would re-introduce exactly the per-render gate the team
deleted, so it is superseded by the following three-part model:

1. **Cheap renders stay allowlisted** - no per-render long-poll, so the operator
   runs unattended for normal spend (no footgun).
2. **Hard per-ad budget cap in the worker** - the generation handler sums the
   estimated kie cost (per clip x segments) before any submit and aborts with a
   clear error if it would exceed the brief/pipeline budget. kie has no upstream
   per-render cap, so this is the structural backstop.
3. **Over-threshold renders escalate to manager approval** - when the estimated
   cost of a render exceeds a configured per-ad threshold (e.g. premium Veo
   Standard + audio, or a long multi-clip assembly), that render long-polls the
   dashboard for an audited approval before submitting; below the threshold it
   proceeds.

Implementation (verified against the plugin): `policy.evaluate(tool_name, args,
ctx)` gates by tool name but ALREADY inspects `args` for one tool class (the
`ALWAYS_ASK_PATTERNS` destructive-command check). There is no conditional/threshold
approval and no on-demand "request approval" API today. So the over-threshold gate
is implemented by EXTENDING `policy.evaluate` with an args-aware branch for
`video_render`: it reads the render's cost-estimate inputs (model, clip count,
resolution) from `args` and returns `ask_operator(risk_class="spend")` when the
estimate exceeds the per-ad threshold, else `allow`. This requires the
`video_render` tool to carry those cost inputs in its arguments. The hard per-ad
budget cap is a separate, worker-side abort before the kie submit. The standing
HARD gate (Meta launch) is unchanged. Implemented across VID-5 (worker cap) and
VID-7 (the `policy.evaluate` extension + `policy.operator.yaml` allowlist for
`video_brief` / `broll_select`).

### D2. B-roll source + selection mode  ·  CONFIRMED (both) + one nuance
Decision taken: **both** generated (`kie_video`) and stock (`yt-dlp`) clips; the
`broll_clips` jsonb already records `store_backend` per clip, so it natively
supports a mixed shortlist. Nuance to confirm: `video_briefs.broll_selection_mode`
defaults to **`review_each`** in the schema (human picks each clip), while the
pipeline generation path forces `mode="auto"` (no UI block mid-generation). That
is correct - the operator/manager curates at the `review` gate, and unattended
generation runs `auto`. No change needed; flagged so it is intentional.

### D3. Voiceover backend  ·  CONFIRMED
kie's ElevenLabs TTS via `services.kie_tts` (PR #408). No new vendor/key;
consistent with "generation = kie.ai." Compliance applies spoken-claim review to
`voiceover_text` (invisible to image OCR) - a video-specific rubric (Layer F).

### D4. Operator skill structure  ·  CONFIRMED
Mirror the established `SKILL.md` + `helper.py` + `mcp_server.py` pattern (10
existing skills). `helper.py` is pure validation/builders, not a junk drawer:
its job is to keep the agent's output in lock-step with the worker schema and to
fail loudly before a paid call. One nuance the schema dictates: the video brief's
strategy fields (`market`, `offer_text`, `angles`) live in the `payload` jsonb,
while `target_duration_s`/`voice_id`/`hook_style`/`dimensions`/`captions_style`/
`broll_selection_mode` are first-class `video_briefs` columns - so
`build_video_brief` and the worker's video-brief endpoint must agree on that
payload-vs-column split (finalize in VID-6/7 against the endpoint).

---

## 5. Revised PR sequence (reflecting the real gaps)

1. **VID-1..4** - generation services (broll, kie_video, ffmpeg_compose, captions). DONE: PRs #404-#407.
2. **VID-5a** - kie TTS voiceover client. DONE: PR #408.
3. **MERGE GATE** - merge #404-#408 to `main` so VID-5 can import them.
4. **VID-5** - rewrite `video.py`'s 6 handlers on the new stack + the worker per-ad budget cap (D1) + `_video_substage_cost` update. Depends on step 3.
5. **VID-6** - `video-ad-authoring` skill (`SKILL.md` + `helper.py` + tests). Independent; buildable now.
6. **VID-7** - operator video MCP tools (`video_brief`, `video_render`, `broll_select`) in `pipeline-operator` + worker endpoints + `policy.operator.yaml` per D1. Partly independent.
7. **VID-8** - end-to-end: operator authors -> renders a finished captioned 9:16 through the gates (e2e parity with the image no-stall spec).
8. **VID-9** - video `creative_qa` rubric + ffprobe/frame backstops + `verdict_video`.
9. **VID-10** - video `compliance_review` (HARD): b-roll licensing + music rights + spoken-claim FTC.
10. **VID-11** - video `spec_validation`: ffprobe container/codec/LUFS + derived crops.
11. **VID-12** - copy/finalize/launch video routing: `video_copy_variants`, `video_creatives.drive_url`, `video_launch_packages` -> Meta video ad. Launch stays the HARD gate.

VID-6 and VID-7 are the work to do *now* (while #404-#408 are reviewed/merged),
because they do not import the unmerged worker modules.

---

## 6. Risks + non-goals

**Risks:** (1) clip-to-clip visual drift across the assembly (mitigate with
image-to-video from a fixed reference frame); (2) no hard per-render spend cap
upstream (mitigated by D1's worker budget cap); (3) b-roll/music licensing is a
HARD compliance class for local-services ads (cleared sources only; yt-dlp
scraping is NOT a grant); (4) generative footage of the *actual* service can draw
Meta/TikTok misrepresentation disapprovals, so keep gen to abstract b-roll and
prefer client footage / licensed stock / avatars; (5) kie is a small reseller
(keep fal configured as a generation failover).

**Non-goals (v1):** avatars/talking-head (defer to fal or kie Wan); music as
default (add with the music-rights compliance class); any hosted compose vendor
(local ffmpeg covers it); any container/Dockerfile change beyond the
already-shipped toolchain + the faster-whisper dep (PR #408).
