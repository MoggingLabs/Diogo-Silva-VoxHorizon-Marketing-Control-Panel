import { NextResponse, type NextRequest } from "next/server";

import {
  VideoLaunchInput,
  VideoLaunchPayload,
  videoPayloadToJson,
  type VideoLaunchIssueT,
  type VideoLaunchPackageInsert,
  type VideoLaunchPayloadT,
} from "@/lib/video-launches";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types.gen";
import { callWorker, WorkerError } from "@/lib/worker";

type EventInsert = Database["public"]["Tables"]["events"]["Insert"];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/launches/video
 *
 * Mirror of ``POST /api/launches`` for the video side. See that route's
 * doc for the pre-flight pipeline; the only structural differences are:
 *
 *   - reads from ``video_briefs`` / ``video_creatives`` / ``video_copy_variants``
 *   - approved video creative statuses are ``approved`` only (no ``live``
 *     in the video status enum)
 *   - requires ``captioned_path`` AND ``drive_url`` on each creative
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = VideoLaunchInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { brief_id } = parsed.data;

  const supabase = createAdminClient();

  const { data: brief, error: briefErr } = await supabase
    .from("video_briefs")
    .select(
      "id, brief_id_human, status, payload, target_duration_s, voice_id, dimensions, client_id, clients(id, slug, name)",
    )
    .eq("id", brief_id)
    .maybeSingle();
  if (briefErr) return NextResponse.json({ error: briefErr.message }, { status: 500 });
  if (!brief) return NextResponse.json({ error: "video brief not found" }, { status: 404 });
  if (brief.status !== "approved" && brief.status !== "approved_with_changes") {
    return NextResponse.json(
      {
        error: "invalid_state",
        current: brief.status,
        expected: "approved | approved_with_changes",
      },
      { status: 409 },
    );
  }

  const { data: videoCreatives, error: vcErr } = await supabase
    .from("video_creatives")
    .select("id, version, status, captioned_path, composed_path, drive_url, duration_actual_s")
    .eq("brief_id", brief_id)
    .in("status", ["approved", "captioned"]);
  if (vcErr) return NextResponse.json({ error: vcErr.message }, { status: 500 });

  const issues: VideoLaunchIssueT[] = [];
  const creativeRows = videoCreatives ?? [];
  if (creativeRows.length === 0) {
    issues.push({ severity: "error", message: "Video brief has no approved creatives." });
  }

  const creativeIds = creativeRows.map((c) => c.id);
  const { data: copyVariants, error: copyErr } = creativeIds.length
    ? await supabase
        .from("video_copy_variants")
        .select("id, creative_id, headline, body, cta, status")
        .in("creative_id", creativeIds)
    : { data: [], error: null };
  if (copyErr) return NextResponse.json({ error: copyErr.message }, { status: 500 });
  const copyByCreative = new Map<string, { id: string }[]>();
  for (const cv of copyVariants ?? []) {
    const list = copyByCreative.get(cv.creative_id) ?? [];
    list.push({ id: cv.id });
    copyByCreative.set(cv.creative_id, list);
  }

  for (const c of creativeRows) {
    if (!c.captioned_path) {
      issues.push({
        severity: "error",
        message: `Video creative is missing captioned_path.`,
        ref_table: "video_creatives",
        ref_id: c.id,
      });
    }
    if (!c.drive_url) {
      issues.push({
        severity: "error",
        message: `Video creative is missing Drive URL.`,
        ref_table: "video_creatives",
        ref_id: c.id,
      });
    }
    if ((copyByCreative.get(c.id) ?? []).length === 0) {
      issues.push({
        severity: "error",
        message: `Video creative has no paired copy variants.`,
        ref_table: "video_creatives",
        ref_id: c.id,
      });
    }
  }

  const preflightOk = issues.every((i) => i.severity !== "error");
  let validation: VideoLaunchPayloadT["validation"] = {
    ok: preflightOk,
    via: "preflight",
  };
  try {
    const verdict = await callWorker<{
      ok: boolean;
      issues: string[];
      raw_stdout?: string;
      raw_stderr?: string;
    }>("/work/launch/validate", {
      method: "POST",
      body: JSON.stringify({
        brief_id,
        format: "video",
        payload: {
          brief: brief.payload,
          target_duration_s: brief.target_duration_s,
          dimensions: brief.dimensions,
          voice_id: brief.voice_id,
          video_creatives: creativeRows,
          copy_variants: copyVariants ?? [],
        },
      }),
    });
    validation = {
      ok: verdict.ok && preflightOk,
      via: "scripts_runner",
      raw_stdout: verdict.raw_stdout,
      raw_stderr: verdict.raw_stderr,
    };
    for (const msg of verdict.issues ?? []) {
      issues.push({ severity: verdict.ok ? "warning" : "error", message: msg });
    }
  } catch (err) {
    if (err instanceof WorkerError) {
      console.warn(`[POST /api/launches/video] worker unavailable: ${err.message}`);
    } else {
      console.warn(`[POST /api/launches/video] worker call failed`, err);
    }
  }

  const finalOk = validation.ok && issues.every((i) => i.severity !== "error");
  const payload: VideoLaunchPayloadT = {
    brief_id_human: brief.brief_id_human,
    client: brief.clients
      ? { id: brief.clients.id, slug: brief.clients.slug, name: brief.clients.name }
      : null,
    video_creative_ids: creativeRows.map((c) => c.id),
    copy_variant_ids: (copyVariants ?? []).map((cv) => cv.id),
    issues,
    validation,
  };
  VideoLaunchPayload.parse(payload);

  const insertRow: VideoLaunchPackageInsert = {
    brief_id,
    status: finalOk ? "posted" : "failed",
    payload: videoPayloadToJson(payload) as Json,
  };

  const { data: launch, error: insertErr } = await supabase
    .from("video_launch_packages")
    .insert(insertRow)
    .select()
    .single();
  if (insertErr || !launch) {
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }

  const evt: EventInsert = {
    kind: finalOk ? "video_launch_package_posted" : "video_launch_package_failed",
    ref_table: "video_launch_packages",
    ref_id: launch.id,
    payload: { brief_id, issue_count: issues.length, validation } as Json,
  };
  await supabase.from("events").insert(evt);

  return NextResponse.json({ launch }, { status: finalOk ? 201 : 422 });
}

/** GET /api/launches/video — newest-first list. */
export async function GET(req: NextRequest) {
  const supabase = createAdminClient();
  const url = new URL(req.url);
  const briefId = url.searchParams.get("brief_id");
  const status = url.searchParams.get("status");

  let query = supabase
    .from("video_launch_packages")
    .select("id, brief_id, status, created_at, decided_at, decided_notes")
    .order("created_at", { ascending: false })
    .limit(200);

  if (briefId) query = query.eq("brief_id", briefId);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ launches: data ?? [] });
}
