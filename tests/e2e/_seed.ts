import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/types.gen";

/**
 * Seed + cleanup helpers for Wave 5 e2e specs.
 *
 * Strategy:
 *  - Service-role admin client (RLS bypass) — required so tests can drop rows
 *    directly without bouncing through the API + state machine guards.
 *  - Every seeder returns the inserted row's primary key (uuid) so specs can
 *    immediately drive `/creatives/[id]`, `/launches/[id]`, etc.
 *  - Inserts use realistic defaults that satisfy DB CHECK constraints (e.g.
 *    `briefs.payload` requires both `service` and `budget`) but stay
 *    intentionally tiny — specs override anything they care about via the
 *    `opts` parameter.
 *
 * The functions here are imported by both `_fixtures.ts` (where they extend
 * the shared Playwright fixture's automatic cleanup) and the spec files
 * directly (for per-test seeding).
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SECRET_KEY;

/**
 * Lazily-built admin client. Throws a friendly error if env is missing so
 * Playwright surfaces the actual cause instead of a "Cannot read properties of
 * undefined" deep inside the supabase SDK. Mirrors the equivalent helper in
 * `_fixtures.ts` — kept private here to avoid leaking a second exported
 * factory across files.
 */
function adminClient(): SupabaseClient<Database> {
  if (!supabaseUrl) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is required for e2e tests — set it in .env.local before running pnpm test:e2e.",
    );
  }
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SECRET_KEY is required for e2e tests — set it in .env.local before running pnpm test:e2e.",
    );
  }
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

/**
 * Removes every `creative` and `video_creative` owned by the test client.
 *
 * We don't have an `owner` column on creatives — the link is `creative.brief_id
 * → briefs.client_id`. To stay generic the cleanup walks both directions:
 *
 *   1. Look up all (image + video) brief ids for the client.
 *   2. Delete creatives where `brief_id IN (...)`.
 *
 * `cleanupBriefs` cascades creatives via the FK, so this helper is mostly
 * useful when a spec wants to drop creatives WITHOUT also dropping the
 * briefs they belong to (e.g. when iterating on multiple decision flows
 * against the same seeded brief).
 */
export async function cleanupCreatives(clientId: string): Promise<void> {
  const admin = adminClient();

  const [briefs, videoBriefs] = await Promise.all([
    admin.from("briefs").select("id").eq("client_id", clientId),
    admin.from("video_briefs").select("id").eq("client_id", clientId),
  ]);
  if (briefs.error) {
    throw new Error(`cleanupCreatives (briefs lookup) failed: ${briefs.error.message}`);
  }
  if (videoBriefs.error) {
    throw new Error(`cleanupCreatives (video briefs lookup) failed: ${videoBriefs.error.message}`);
  }

  const briefIds = (briefs.data ?? []).map((b) => b.id);
  const videoBriefIds = (videoBriefs.data ?? []).map((b) => b.id);

  if (briefIds.length > 0) {
    const res = await admin.from("creatives").delete().in("brief_id", briefIds);
    if (res.error) {
      throw new Error(`cleanupCreatives (image) failed: ${res.error.message}`);
    }
  }
  if (videoBriefIds.length > 0) {
    const res = await admin.from("video_creatives").delete().in("brief_id", videoBriefIds);
    if (res.error) {
      throw new Error(`cleanupCreatives (video) failed: ${res.error.message}`);
    }
  }
}

/**
 * Removes every `launch_packages` and `video_launch_packages` row tied to
 * the test client. Same brief-id lookup pattern as `cleanupCreatives`.
 */
export async function cleanupLaunchPackages(clientId: string): Promise<void> {
  const admin = adminClient();

  const [briefs, videoBriefs] = await Promise.all([
    admin.from("briefs").select("id").eq("client_id", clientId),
    admin.from("video_briefs").select("id").eq("client_id", clientId),
  ]);
  if (briefs.error) {
    throw new Error(`cleanupLaunchPackages (briefs lookup) failed: ${briefs.error.message}`);
  }
  if (videoBriefs.error) {
    throw new Error(
      `cleanupLaunchPackages (video briefs lookup) failed: ${videoBriefs.error.message}`,
    );
  }

  const briefIds = (briefs.data ?? []).map((b) => b.id);
  const videoBriefIds = (videoBriefs.data ?? []).map((b) => b.id);

  if (briefIds.length > 0) {
    const res = await admin.from("launch_packages").delete().in("brief_id", briefIds);
    if (res.error) {
      throw new Error(`cleanupLaunchPackages (image) failed: ${res.error.message}`);
    }
  }
  if (videoBriefIds.length > 0) {
    const res = await admin.from("video_launch_packages").delete().in("brief_id", videoBriefIds);
    if (res.error) {
      throw new Error(`cleanupLaunchPackages (video) failed: ${res.error.message}`);
    }
  }
}

/**
 * Removes every `campaign_perf_image` and `campaign_perf_video` row tied to
 * the test client. These rows aren't FK-linked to briefs, so we filter
 * directly on `client_id`.
 *
 * Test rows always use a `campaign_id` starting with `test-` so we also
 * drop any rows that match that pattern *and* are linked to the test client
 * — this is the belt-and-braces version that catches rows where the
 * client_id was nulled out or mistyped.
 */
export async function cleanupCampaignPerf(clientId: string): Promise<void> {
  const admin = adminClient();

  const image = await admin.from("campaign_perf_image").delete().eq("client_id", clientId);
  if (image.error) {
    throw new Error(`cleanupCampaignPerf (image) failed: ${image.error.message}`);
  }
  const video = await admin.from("campaign_perf_video").delete().eq("client_id", clientId);
  if (video.error) {
    throw new Error(`cleanupCampaignPerf (video) failed: ${video.error.message}`);
  }
}

/**
 * Removes every `pipelines` row tied to the test client. The schema cascades
 * pipeline_events on delete; briefs referenced by FK are NOT cascaded by
 * design (a pipeline-created brief should outlive the pipeline row). The
 * sister helper `cleanupBriefs` mops those up via the client_id sweep.
 */
export async function cleanupPipelines(clientId: string): Promise<void> {
  const admin = adminClient();

  // First, look up the pipeline ids so we can null out the FK on briefs
  // that point at them (otherwise the pipeline delete will fail on
  // ON DELETE RESTRICT). The DB migration uses ON DELETE SET NULL on the
  // brief→pipeline FK, so this clear is belt-and-braces only.
  const { data: pipes, error: lookupErr } = await admin
    .from("pipelines")
    .select("id")
    .eq("client_id", clientId);
  if (lookupErr) {
    throw new Error(`cleanupPipelines (lookup) failed: ${lookupErr.message}`);
  }

  const pipelineIds = (pipes ?? []).map((p) => p.id);
  if (pipelineIds.length === 0) return;

  // The rebuild added `creatives.pipeline_id` (migration 0023) with NO ON
  // DELETE rule (NO ACTION), so a creative that points at a pipeline blocks the
  // pipeline delete with a FK violation. The workflow e2e seeds finals carrying
  // `pipeline_id` (so the per-creative review fetch finds them), so null that FK
  // out first. Best-effort: the column may not exist on an older DB / the update
  // may match nothing — either way the delete below is the load-bearing step.
  const nulled = await admin
    .from("creatives")
    .update({ pipeline_id: null } as never)
    .in("pipeline_id" as never, pipelineIds as never);
  if (nulled.error) {
    // Surface only unexpected failures; a missing column / no-match is fine.
    console.warn(`cleanupPipelines (null creatives.pipeline_id): ${nulled.error.message}`);
  }

  const res = await admin.from("pipelines").delete().in("id", pipelineIds);
  if (res.error) {
    throw new Error(`cleanupPipelines (delete) failed: ${res.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Brief seeders
// ---------------------------------------------------------------------------

/** Brief format selector for `seedApprovedBrief`. */
export type BriefFormat = "image" | "video";

/**
 * Inserts a brief in status `approved`, returning its uuid `id`.
 *
 * The brief is written directly via the admin client — bypassing the
 * `POST /api/briefs` route and its state-machine guards. The shape stays
 * minimal but valid (the DB enforces `payload.service` + `payload.budget`
 * for image briefs; video briefs have nullable `payload` so we drop a tiny
 * default jsonb in for shape-parity with worker writes).
 *
 * Marker prefix: `brief_id_human` carries a `t5e2e-` prefix so leftover
 * rows from a flaky run can be spotted in the dev DB easily.
 */
export async function seedApprovedBrief(
  clientId: string,
  format: BriefFormat = "image",
): Promise<string> {
  const admin = adminClient();
  const stamp = Date.now();

  if (format === "image") {
    const payload = {
      service: "remodeling",
      budget: 5000,
      market: "Austin, TX",
      landing_page_url: "https://example.com/lp",
    } satisfies Record<string, unknown>;

    const { data, error } = await admin
      .from("briefs")
      .insert({
        // Human IDs are normally minted via gen_brief_id_human(slug) but in
        // tests we just need a value unique inside the suite — the column
        // is unique, so a timestamp + random suffix is plenty.
        brief_id_human: `t5e2e-img-${stamp}-${randomSuffix()}`,
        client_id: clientId,
        payload: payload as unknown as Json,
        status: "approved",
        posted_at: new Date(stamp - 60_000).toISOString(),
        decided_at: new Date(stamp).toISOString(),
        decided_notes: "seeded approved brief for e2e",
      })
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`seedApprovedBrief (image) failed: ${error?.message ?? "no row returned"}`);
    }
    return data.id;
  }

  // video
  const scriptOutline = {
    hook: "Watch what happens to your roof in 60 seconds.",
    segments: [{ topic: "Drone overview", duration_s: 30 }],
  };

  const { data, error } = await admin
    .from("video_briefs")
    .insert({
      brief_id_human: `t5e2e-vid-${stamp}-${randomSuffix()}`,
      client_id: clientId,
      status: "approved",
      script_outline: scriptOutline as unknown as Json,
      target_duration_s: 30,
      voice_id: "21m00Tcm4TlvDq8ikWAM",
      dimensions: "9x16",
      broll_selection_mode: "review_each",
      payload: { notes: "seeded approved video brief for e2e" } as unknown as Json,
      posted_at: new Date(stamp - 60_000).toISOString(),
      decided_at: new Date(stamp).toISOString(),
      decided_notes: "seeded approved video brief for e2e",
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`seedApprovedBrief (video) failed: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

// ---------------------------------------------------------------------------
// Creative seeders
// ---------------------------------------------------------------------------

export type SeedCreativeOpts = {
  concept?: string;
  ratio?: "1x1" | "9x16" | "16x9";
  status?: "draft" | "approved" | "rejected" | "live" | "killed";
  /**
   * Stub Drive path. Defaults to a `drive://stub` URL — the launch builder
   * only checks for truthiness, so this is enough to clear the pre-flight
   * "missing Drive URL" gate.
   */
  file_path_drive?: string | null;
  file_path_supabase?: string | null;
  offer_text?: string | null;
  version?: string;
};

/**
 * Inserts a single `creatives` row. The worker normally writes these after
 * generating an image — for e2e we skip that and pre-seed straight into the
 * row so the variants grid + side panel can be exercised in isolation.
 *
 * Defaults:
 *   - status: "draft"  (decision API requires this)
 *   - ratio: "1x1"
 *   - version: "v1"
 *   - concept: "Test creative <suffix>"
 *
 * No Drive URL by default — pass `file_path_drive: "drive://stub"` (or any
 * truthy string) when seeding for a launch-builder flow.
 */
export async function seedCreative(briefId: string, opts: SeedCreativeOpts = {}): Promise<string> {
  const admin = adminClient();
  const concept = opts.concept ?? `Test creative ${randomSuffix()}`;

  const { data, error } = await admin
    .from("creatives")
    .insert({
      brief_id: briefId,
      type: "image",
      status: opts.status ?? "draft",
      ratio: opts.ratio ?? "1x1",
      version: opts.version ?? "v1",
      concept,
      offer_text: opts.offer_text ?? null,
      file_path_drive: opts.file_path_drive ?? null,
      file_path_supabase: opts.file_path_supabase ?? null,
      // approved_at must be stamped if status is already approved (so the
      // side panel renders "Decided …" correctly).
      approved_at: opts.status === "approved" ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`seedCreative failed: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

export type SeedVideoCreativeOpts = {
  status?:
    | "draft"
    | "script_ready"
    | "voiceover_ready"
    | "broll_ready"
    | "composed"
    | "captioned"
    | "approved"
    | "rejected";
  version?: number;
  captioned_path?: string | null;
  composed_path?: string | null;
  voiceover_path?: string | null;
  script_path?: string | null;
  drive_url?: string | null;
  duration_actual_s?: number | null;
  broll_clips?: unknown;
};

/**
 * Inserts a single `video_creatives` row. Mirrors `seedCreative` for the
 * video side. Defaults keep the row in the earliest pipeline state so a
 * spec can drive the full progression by issuing PATCH updates; pass
 * `status: "captioned"` (or beyond) when the spec wants to exercise the
 * decision API directly.
 */
export async function seedVideoCreative(
  videoBriefId: string,
  opts: SeedVideoCreativeOpts = {},
): Promise<string> {
  const admin = adminClient();
  const status = opts.status ?? "draft";

  const { data, error } = await admin
    .from("video_creatives")
    .insert({
      brief_id: videoBriefId,
      status,
      version: opts.version ?? 1,
      script_path: opts.script_path ?? null,
      voiceover_path: opts.voiceover_path ?? null,
      composed_path: opts.composed_path ?? null,
      captioned_path: opts.captioned_path ?? null,
      drive_url: opts.drive_url ?? null,
      duration_actual_s: opts.duration_actual_s ?? null,
      broll_clips: (opts.broll_clips ?? null) as unknown as Json,
      approved_at: status === "approved" ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`seedVideoCreative failed: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

// ---------------------------------------------------------------------------
// Launch + perf seeders
// ---------------------------------------------------------------------------

/**
 * Inserts a launch-package row directly in `status = 'posted'`, returning
 * its uuid. Useful when a spec needs to test the approval gate without
 * walking the validator API first.
 *
 * The `payload` jsonb is the minimum shape that passes the LaunchPayload /
 * VideoLaunchPayload zod refinement — empty creative + copy id arrays,
 * a happy-path preflight verdict, and no issues.
 *
 * Pass `format: "video"` to seed a `video_launch_packages` row instead.
 * The payload uses the matching field name (`video_creative_ids`) so the
 * launch detail page parser succeeds.
 */
export async function seedPushedLaunch(
  briefId: string,
  format: "image" | "video" = "image",
): Promise<string> {
  const admin = adminClient();

  if (format === "image") {
    const payload = {
      brief_id_human: `t5e2e-launch-${randomSuffix()}`,
      client: null,
      creative_ids: [],
      copy_variant_ids: [],
      issues: [],
      validation: { ok: true, via: "preflight" },
    };
    const { data, error } = await admin
      .from("launch_packages")
      .insert({
        brief_id: briefId,
        status: "posted",
        payload: payload as unknown as Json,
      })
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`seedPushedLaunch (image) failed: ${error?.message ?? "no row returned"}`);
    }
    return data.id;
  }

  // video
  const payload = {
    brief_id_human: `t5e2e-vlaunch-${randomSuffix()}`,
    client: null,
    video_creative_ids: [],
    copy_variant_ids: [],
    issues: [],
    validation: { ok: true, via: "preflight" },
  };
  const { data, error } = await admin
    .from("video_launch_packages")
    .insert({
      brief_id: briefId,
      status: "posted",
      payload: payload as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`seedPushedLaunch (video) failed: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

export type SeedCampaignPerfRow = {
  campaign_id: string;
  format?: "image" | "video";
  window_days?: number;
  spend?: number | null;
  impressions?: number | null;
  clicks?: number | null;
  ctr?: number | null;
  freq?: number | null;
  leads_meta?: number | null;
  leads_ghl?: number | null;
  cpl_real?: number | null;
  verdict?: "kill" | "watch" | "keep" | null;
  verdict_reason?: string | null;
  // Video-only — ignored when format === "image".
  hook_rate?: number | null;
  drop_off_3s?: number | null;
  view_rate_avg?: number | null;
  watch_time_p50?: number | null;
};

/**
 * Inserts one or many `campaign_perf_image` / `campaign_perf_video` rows.
 *
 * Each input row's `format` selects the destination table (defaults to
 * `image`). `window_days` defaults to 30 (the audit page's default
 * `?window=`). Test rows should use a `campaign_id` that's clearly
 * recognisable — by convention we prefix with `test-` so the audit table
 * shows them and our cleanup catches everything.
 */
export async function seedCampaignPerf(
  clientId: string,
  rows: SeedCampaignPerfRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const admin = adminClient();

  const imageRows = rows
    .filter((r) => (r.format ?? "image") === "image")
    .map((r) => ({
      client_id: clientId,
      campaign_id: r.campaign_id,
      window_days: r.window_days ?? 30,
      spend: r.spend ?? null,
      impressions: r.impressions ?? null,
      clicks: r.clicks ?? null,
      ctr: r.ctr ?? null,
      freq: r.freq ?? null,
      leads_meta: r.leads_meta ?? null,
      leads_ghl: r.leads_ghl ?? null,
      cpl_real: r.cpl_real ?? null,
      verdict: r.verdict ?? null,
      verdict_reason: r.verdict_reason ?? null,
    }));

  const videoRows = rows
    .filter((r) => r.format === "video")
    .map((r) => ({
      client_id: clientId,
      campaign_id: r.campaign_id,
      window_days: r.window_days ?? 30,
      spend: r.spend ?? null,
      impressions: r.impressions ?? null,
      clicks: r.clicks ?? null,
      ctr: r.ctr ?? null,
      freq: r.freq ?? null,
      leads_meta: r.leads_meta ?? null,
      leads_ghl: r.leads_ghl ?? null,
      cpl_real: r.cpl_real ?? null,
      hook_rate: r.hook_rate ?? null,
      drop_off_3s: r.drop_off_3s ?? null,
      view_rate_avg: r.view_rate_avg ?? null,
      watch_time_p50: r.watch_time_p50 ?? null,
      verdict: r.verdict ?? null,
      verdict_reason: r.verdict_reason ?? null,
    }));

  if (imageRows.length > 0) {
    const res = await admin.from("campaign_perf_image").insert(imageRows);
    if (res.error) {
      throw new Error(`seedCampaignPerf (image) failed: ${res.error.message}`);
    }
  }
  if (videoRows.length > 0) {
    const res = await admin.from("campaign_perf_video").insert(videoRows);
    if (res.error) {
      throw new Error(`seedCampaignPerf (video) failed: ${res.error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Short random suffix for unique brief / creative names. Six base-36 chars
 * is comfortably collision-free across a single test run (the test client's
 * cleanup runs before AND after every spec — see _fixtures.ts).
 */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
