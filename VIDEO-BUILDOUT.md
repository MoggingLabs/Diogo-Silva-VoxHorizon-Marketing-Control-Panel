# Video Pipeline Build-Out Roadmap

**Initiative:** Bring the video-ad pipeline to parity with the image pipeline, running through the same gated, per-creative operator DAG.
**Issue series:** `VID-` · **Status:** scope draft, pending approval.
**Owner:** Diogo (manager / approver). The Operator does the work; the manager gates.

> Companion docs: [`OPERATOR-BUILDOUT.md`](./OPERATOR-BUILDOUT.md) (the image build-out this mirrors), [`PIPELINE-REBUILD-ARCHITECTURE.md`](./PIPELINE-REBUILD-ARCHITECTURE.md) (the per-creative state model + 9 sync points this reuses).

---

## 1. Locked decisions (the backend choice)

Decided after a fal.ai vs kie.ai vs alternatives review (2026-05-23):

- **Generation = kie.ai.** The worker already integrates kie for images (`worker/src/services/kie.py`, `KieClient`, `nano-banana-2` / Flux / Seedream). Extend the same client for video. kie is 30-80% cheaper than fal on the same upstream models, has HMAC-SHA256 signed callbacks, and does native 9:16 (Veo 3.1, Kling, Sora 2, Seedance) plus Suno music + ElevenLabs TTS.
- **Compose + captions = LOCAL, in the worker.** The worker image already ships `ffmpeg` (`worker/Dockerfile` line ~76), Hyperframes + Node 22 (line ~82), Chromium (the Playwright base), Pillow, and yt-dlp. HI-8 deleted the video service code, not the tooling. So clip concat + VO/music mux + styled caption burn-in + brand/CTA overlays run in-container at $0, deterministic, with full font/brand control. Caption timings via self-hosted Whisper (or the OpenAI Whisper API at $0.006/min). Premium kinetic/animated captions use the already-installed Hyperframes (HTML to MP4); basic-to-good styled captions are pure ffmpeg.
- **fal.ai = optional.** Not required for v1. Reserve it only for avatar / lip-sync (if a talking-head format is wanted and kie's Wan lip-sync is not enough) and as a cross-vendor generation failover.
- **No new vendor or container change is required for v1.** Net cost ~$1.25 per ~24s ad (kie generation + $0 local compose).
- **Human-in-the-loop preserved.** Video reuses the same gates; new stages add gates, never remove them. Video generation SPENDS, so its render tool is approval-gated (unlike the free image render).
- **No AI attribution** in any commit/PR/issue body (house rule). No em dashes in agent-facing files (SOUL/AGENTS/MEMORY/SKILL).

---

## 2. Current state (baseline)

| Thing | State |
|---|---|
| `worker/src/routes/video.py` | Dormant stub: 6 substage handlers raise `NotImplementedError(_NOT_RESTORED)`. Docstring names the recovery ref `381eb4a^` (HI-8 deleted ~25k LOC of video code). |
| `worker/src/routes/pipeline.py` | Still drives video: `_VIDEO_SUBSTAGES = (script, voiceover, broll_search, broll_pick, compose, caption)`, dispatcher `_run_video_substage`, cost table `_video_substage_cost`. This is the seam to plug into. |
| `worker/src/services/atomic_inserts_video.py` | Intact (`record_video_stage`). The DB write layer survives. |
| DB | `video_briefs` / `video_creatives` / `video_iterations` / `video_copy_variants` / `video_launch_packages` exist (see `db/SCHEMA.md`); only `0004_v1_video_brief_constraints.sql`. Data spine is ready. |
| Operator | No video skill (only `image-ad-authoring` + `pipeline-operator` + the 5 image stage skills). |
| Worker image | ffmpeg + Hyperframes + Chromium + Pillow + yt-dlp already installed. |

So the work is: **restore the cheap deterministic services, repoint generation at kie, do compose locally, and add the operator video surface.** Much of it is porting + rewiring, not inventing.

---

## 3. Architecture (reuse the 12-stage gated DAG)

Video runs through the **same** pipeline stages and the **same** per-creative `creative_stage_state` model as image (see `PIPELINE-REBUILD-ARCHITECTURE.md`). The gate machinery keys on `creative_id`, so the operator's existing array-persist tools (`qa_result`, `compliance_result`, `copy`, `spec_result`, `finalize_result`, `monitor_result`, `signal`) are reused as-is; the worker routes them to the `video_*` tables based on `pipelines.format` / `format_choice`.

What is video-specific is the **generation** stage's internal substage chain and the **authoring craft**:

```
configuration -> ideation -> review -> generation* -> creative_qa -> compliance_review (HARD)
  -> copy -> spec_validation -> variant_plan -> finalize_assets -> launch_handoff (HARD) -> monitor -> done

*generation (video) runs the substage chain:
   script -> voiceover (kie TTS / Suno) -> broll_search (yt-dlp) -> broll_pick (deterministic score, or operator review)
   -> compose (LOCAL ffmpeg / Hyperframes: clips + VO + music + overlays) -> caption (Whisper timings + ffmpeg burn-in)
```

Render backends per substage:
- **script** -> operator authors via the new `video-ad-authoring` skill (no spend).
- **voiceover** -> kie ElevenLabs TTS, or Veo/Wan native audio (paid; gated).
- **broll clips** -> kie video models (Veo 3.1 Fast default, Kling/Seedance options; paid; gated) and/or yt-dlp-sourced stock (license-gated in compliance).
- **music** -> kie Suno (optional; license-gated).
- **compose + caption** -> LOCAL ffmpeg / Hyperframes + Whisper ($0).

---

## 4. Restore vs rebuild map (from `381eb4a^`)

Recover with `git restore --source=381eb4a^ -- <path>` (diff intact files to a scratch path first).

| File | Decision |
|---|---|
| `services/broll_selection.py` | **Restore** (pure deterministic token-overlap scoring; no deps). |
| `services/broll_search.py` | **Restore** + re-validate the yt-dlp scrape. |
| `services/broll_store.py` | **Restore** (storage adapter; `broll_store_backend` local/supabase). |
| `services/verdict_video.py` | **Restore** (pure hook-rate / drop-off / watch-time; feeds video monitor + QA). |
| `routes/broll.py` | **Restore** only if keeping the per-segment `review_each` UI. |
| `services/atomic_inserts_video.py` | **Keep live copy**; diff against `381eb4a^` and take the union. |
| `routes/video.py` | **Restore as scaffold**, then rewrite the substage bodies for the new stack (kie gen + local compose). |
| `services/hyperframes.py` | **Rebuild thin** around the already-installed Hyperframes CLI (compose), OR replace with a pure-ffmpeg composer. |
| `services/elevenlabs.py` / `submagic.py` | **Replace with kie TTS + local Whisper/ffmpeg captions** (cheaper, fewer vendors). Restore only if you specifically want those SaaS. |
| New: `services/ffmpeg_compose.py` | **New**: the local composer (concat + mux + overlay + burn-in) shelling to ffmpeg. |
| New: `services/captions.py` | **New**: Whisper timings -> ASS/SRT -> ffmpeg burn-in. |
| New: `KieClient.generate_video()` | **New** in `kie.py`: submit + HMAC callback for kie video models. |

---

## 5. Operator surface

- **New skill `ekko-skills/video-ad-authoring/`** mirroring `image-ad-authoring`: video brief (market, offer, angles, target_duration_s, hook_style, 9:16, voice, music, broll_selection_mode) + N distinct script concepts (hook + segments[{topic, duration_s, voiceover_text, voiceover_direction, broll_query, broll_intent, captions_emphasis}] + outro). Donors: Ekko `video-talking-head` + `broll-sourcing` SKILLs. House rule: humanizer pass on `voiceover_text`, no banned words.
- **Extend `ekko-skills/pipeline-operator/SKILL.md`** with a `format_choice == "video"` branch routing the generation stage to the substage chain and the new tools; the gated stages (qa/compliance/copy/spec/finalize/monitor) are unchanged.
- **New MCP tools** in `mcp_server.py` + `helper.py` (mirror the existing pattern): `pipeline_operator_video_brief` (free write), `pipeline_operator_video_render` (triggers the substage chain; **paid -> approval-gated**), `pipeline_operator_broll_select` (free; resolves `review_each`). Reuse the existing persist tools for qa/compliance/copy/spec/finalize/monitor.
- **Spend gate (`ekko-plugins/voxhorizon_approvals/policy.operator.yaml`)**: add `mcp_pipeline_operator_pipeline_operator_video_render` to `extra_requires_approval` (video generation costs real money, unlike free image render); allowlist `..._video_brief` + `..._broll_select`. The operator/QA gate must sum the estimated kie cost before submit and abort over the per-ad budget (neither vendor has a hard per-render cap).

---

## 6. Gate extensions (rubrics only; plumbing reused)

- **creative_qa** (extend `creative-qa`): lip-sync drift (talking-head), caption legibility + safe-zones at 9:16, hook strength in first 3s, A/V sync + audio clipping, b-roll continuity. Backstop via ffprobe + sampled-frame OCR + restored `verdict_video`.
- **compliance_review** (extend `ad-compliance`, HARD): **b-roll licensing** (every clip in `video_creatives.broll_clips` must be license-clear; yt-dlp scraping is NOT a grant), **music rights** (`music_track` must be licensed/royalty-free), spoken-claim FTC + per-client do-not-say applied to `voiceover_text` (invisible to image OCR), and avatar/likeness consent if avatars are used.
- **spec_validation** (extend): container/codec (H.264/MP4), bitrate + file size, duration per placement, true 9:16 (1080x1920) + derived crops, audio loudness (LUFS). Backstop via ffprobe/ffmpeg (replaces the image Pillow crop).

---

## 7. The 9 sync points per stage

Any new stage/enum touches the same sync points as the image build (`OPERATOR-BUILDOUT.md` section 3): DB enum -> Python `PipelineStage` -> two TS unions (`lib/pipeline/types.ts` + `schemas.ts`) -> label/badge maps + page placeholder + stepper -> advance/decision route -> `lib/operator/dispatch.ts` -> maybe new MCP tool + trigger -> regenerate `lib/supabase/types.gen.ts`. Video adds NO new pipeline stages (it reuses the 12), so the sync-point churn is limited to the video substage enum + the `video_*` tool wiring.

---

## 8. PR-sized sequence (each independently shippable)

1. **VID-1 Restore safe services.** `git restore` `broll_selection`, `broll_search`, `broll_store`, `verdict_video` + tests from `381eb4a^`; reconcile `atomic_inserts_video`. Dormant-but-importable; tests green. (Lowest risk.)
2. **VID-2 `KieClient.generate_video()` + HMAC callback.** Extend `kie.py` for kie video models (Veo 3.1 Fast default), submit + signed-callback handling; unit-tested with `FAKE_*` stub.
3. **VID-3 Local compose service.** New `ffmpeg_compose.py` (concat clips + mux VO/music + logo/CTA overlay -> 9:16 MP4) shelling to the in-image ffmpeg; golden-output test.
4. **VID-4 Local captions.** New `captions.py` (Whisper timings -> ASS/SRT -> ffmpeg burn-in); style presets.
5. **VID-5 Restore + rewrite `video.py` substage bodies** on the new stack (script/voiceover/broll/compose/caption), wired to `pipeline.py`'s existing `_run_video_substage` dispatcher.
6. **VID-6 `video-ad-authoring` skill** (mirror image; donors video-talking-head + broll-sourcing).
7. **VID-7 Operator video branch + MCP tools** (`video_brief`, `video_render`, `broll_select`) + `policy.operator.yaml` spend-gate entry + per-ad budget check.
8. **VID-8 End-to-end generation** (operator authors -> renders a finished captioned 9:16 MP4 through the gates).
9. **VID-9 Video `creative_qa`** rubric + ffprobe/frame backstops + `verdict_video` into the QA/monitor path.
10. **VID-10 Video `compliance_review`** (b-roll licensing + music rights + spoken-claim FTC) HARD gate.
11. **VID-11 Video `spec_validation`** (ffprobe specs + crops + LUFS).
12. **VID-12 Copy / finalize / launch parity** (`video_copy_variants`, video naming + Drive, `video_launch_packages` -> Meta video ad). Launch stays the HARD gate.

Optional later: avatar/talking-head via fal (Kling-Avatar/OmniHuman) or kie Wan lip-sync; background music via Suno (with the music-rights compliance class).

---

## 9. Cost + risks

- **Cost** ~$1.25 per ~24s ad: kie generation (3x 8s Veo 3.1 Fast ~$1.20 + image) + $0 local compose + ~$0 captions (self-Whisper). Premium (Veo Standard/audio, avatars) raises it; the operator gate caps per-ad spend.
- **Risks:** (1) clip-to-clip visual/identity drift across the multi-clip assembly (mitigate with image-to-video from a fixed reference frame); (2) no hard per-render spend cap from kie or fal (enforce in the worker before submit); (3) b-roll/music licensing is a HARD compliance class for local-services ads (cleared sources only); (4) generative footage of the actual service can misrepresent the business (Meta/TikTok review) so keep gen as abstract b-roll and prefer the client's own footage / licensed stock / avatars; (5) kie is a small reseller (keep fal configured as a generation failover).

---

## 10. What is NOT in v1

- Avatars / talking-head (deferred; fal or kie Wan lip-sync when needed).
- Background music as default (add with the music-rights compliance class).
- A hosted compose vendor (local ffmpeg/Hyperframes covers it).
- Any container/Dockerfile change (the toolchain is already installed).
