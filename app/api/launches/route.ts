import { NextResponse, type NextRequest } from "next/server";

import { getSignedUrl } from "@/lib/creatives";
import {
  LaunchInput,
  LaunchPayload,
  payloadToJson,
  type LaunchIssueT,
  type LaunchPackageInsert,
  type LaunchPayloadT,
} from "@/lib/launches";
import { isOperatorDriven } from "@/lib/operator/dispatch";
import { getDerivedStatus } from "@/lib/pipeline/derived-status";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types.gen";
import { callWorker, WorkerError } from "@/lib/worker";

type EventInsert = Database["public"]["Tables"]["events"]["Insert"];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/launches
 *
 * Build an image launch package for an approved brief.
 *
 * Pre-flight pipeline:
 *   1. Brief MUST be in status ``approved`` or ``approved_with_changes``.
 *   2. The brief MUST have at least one approved (or live) creative.
 *   3. Every approved creative MUST have a Drive URL (``file_path_drive``).
 *   4. Every approved creative MUST have at least one copy variant.
 *
 * If any of those fails, we return 422 with the full ``issues`` list so
 * the operator UI can show "missing piece" markers next to each row.
 *
 * On success we:
 *   - Insert a row in ``launch_packages`` with ``status = 'validating'``.
 *   - Call the worker ``/work/launch/validate`` to run the upstream
 *     ``launch_package.py`` (when available — gracefully degrades to a
 *     ``preflight`` validation when the worker / upstream script is
 *     unavailable).
 *   - Transition the row to ``posted`` (success) or ``failed`` (issues).
 *   - Emit a ``launch_package_created`` event.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = LaunchInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { brief_id, pipeline_id } = parsed.data;

  const supabase = createAdminClient();

  // Whether the originating pipeline is operator/codex-driven. This gates the
  // operator-flow accommodations below (Supabase-stored finals with no Drive
  // URL; copy variants optional / image-only) so the legacy Ekko (Drive) flow
  // is left completely unchanged. Resolved from the linked pipeline's
  // ``config_draft`` when a ``pipeline_id`` is supplied (the operator flow
  // always passes one).
  let operatorDriven = false;

  // If the operator handed us a ``pipeline_id``, validate it up-front so the
  // 422 surfaces before we burn the worker round-trip on validation. The
  // pipeline must (a) exist and (b) be in status ``done`` — linking from any
  // earlier stage would race the orchestrator's stage transitions and risk
  // pointing two pipelines at the same launch.
  if (pipeline_id) {
    const { data: pipelineRow, error: pipelineErr } = await supabase
      .from("pipelines")
      .select("id, launch_package_id, config_draft")
      .eq("id", pipeline_id)
      .maybeSingle();
    if (pipelineErr) {
      return NextResponse.json({ error: pipelineErr.message }, { status: 500 });
    }
    if (!pipelineRow) {
      return NextResponse.json({ error: "pipeline not found" }, { status: 404 });
    }
    // Silent-failure PR-4: read derived status from the reducer
    // (`pipelines.status` was dropped in 0051).
    const derivedStatus = await getDerivedStatus(supabase, pipelineRow.id);
    if (derivedStatus !== "done") {
      return NextResponse.json(
        {
          error: "invalid_pipeline_state",
          current: derivedStatus,
          expected: "done",
        },
        { status: 422 },
      );
    }
    operatorDriven = isOperatorDriven(pipelineRow.config_draft);
  }

  // 1. Read brief + client.
  const { data: brief, error: briefErr } = await supabase
    .from("briefs")
    .select("id, brief_id_human, status, payload, client_id, clients(id, slug, name)")
    .eq("id", brief_id)
    .maybeSingle();
  if (briefErr) return NextResponse.json({ error: briefErr.message }, { status: 500 });
  if (!brief) return NextResponse.json({ error: "brief not found" }, { status: 404 });
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

  // 2. Read approved creatives for this brief.
  const { data: creatives, error: creativesErr } = await supabase
    .from("creatives")
    .select("id, concept, ratio, version, status, file_path_drive, file_path_supabase")
    .eq("brief_id", brief_id)
    .in("status", ["approved", "live"]);
  if (creativesErr) return NextResponse.json({ error: creativesErr.message }, { status: 500 });

  const issues: LaunchIssueT[] = [];
  const creativeRows = creatives ?? [];
  if (creativeRows.length === 0) {
    issues.push({ severity: "error", message: "Brief has no approved creatives." });
  }

  // 3. Read copy variants in one query.
  const creativeIds = creativeRows.map((c) => c.id);
  const { data: copyVariants, error: copyErr } = creativeIds.length
    ? await supabase
        .from("copy_variants")
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

  // 4. Per-creative pre-flight.
  //
  // Asset reference: the legacy Ekko flow stores finals in Google Drive and
  // requires ``file_path_drive``. The operator/codex flow stores finals in
  // Supabase Storage (``file_path_supabase`` set, ``file_path_drive`` NULL).
  // For a creative with no Drive URL we fall back to a freshly signed Supabase
  // URL instead of raising the "missing Drive URL" error — so Supabase-stored
  // creatives launch. A creative with NEITHER backend is still a hard error.
  const assetRefs: LaunchPayloadT["asset_refs"] = [];
  for (const c of creativeRows) {
    if (c.file_path_drive) {
      assetRefs.push({ creative_id: c.id, source: "drive", url: c.file_path_drive });
    } else if (c.file_path_supabase) {
      // Sign the private Storage object so the launch package carries a usable
      // URL. A sign failure is non-fatal here — the package still references the
      // creative; we surface it as a warning so the operator can re-sign later.
      const signed = await getSignedUrl(supabase, c.file_path_supabase);
      assetRefs.push({ creative_id: c.id, source: "supabase", url: signed });
      if (!signed) {
        issues.push({
          severity: "warning",
          message: `Creative's Supabase asset could not be signed (will retry at post time).`,
          ref_table: "creatives",
          ref_id: c.id,
        });
      }
    } else {
      issues.push({
        severity: "error",
        message: `Creative is missing both a Drive URL and a Supabase asset path.`,
        ref_table: "creatives",
        ref_id: c.id,
      });
    }

    // Copy variants: required for the legacy flow. For operator-driven /
    // image-only pipelines, copy authoring can come later — downgrade the
    // missing-copy hard error to a warning so an image-only launch passes.
    if ((copyByCreative.get(c.id) ?? []).length === 0) {
      issues.push({
        severity: operatorDriven ? "warning" : "error",
        message: operatorDriven
          ? `Creative has no paired copy variants (optional for image-only operator launches).`
          : `Creative has no paired copy variants.`,
        ref_table: "creatives",
        ref_id: c.id,
      });
    }
  }

  // 5. Optional: ask the worker to run the upstream validator. If the
  //    worker isn't reachable or the script isn't installed, fall back
  //    to a preflight-only verdict.
  const preflightOk = issues.every((i) => i.severity !== "error");
  let validation: LaunchPayloadT["validation"] = {
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
        format: "image",
        payload: {
          brief: brief.payload,
          creatives: creativeRows,
          copy_variants: copyVariants ?? [],
          asset_refs: assetRefs,
          operator_driven: operatorDriven,
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
    // Worker unavailable or upstream script missing — degrade gracefully.
    // The preflight verdict still stands; ``via`` stays ``preflight``.
    if (err instanceof WorkerError) {
      // 503 specifically means "script not installed"; don't flip ok to
      // false on that basis alone — the operator's local validator is
      // the source of truth and they're working offline.
      console.warn(`[POST /api/launches] worker unavailable: ${err.message}`);
    } else {
      console.warn(`[POST /api/launches] worker call failed`, err);
    }
  }

  // 6. Compose the payload + insert.
  const finalOk = validation.ok && issues.every((i) => i.severity !== "error");
  const payload: LaunchPayloadT = {
    brief_id_human: brief.brief_id_human,
    client: brief.clients
      ? { id: brief.clients.id, slug: brief.clients.slug, name: brief.clients.name }
      : null,
    creative_ids: creativeRows.map((c) => c.id),
    copy_variant_ids: (copyVariants ?? []).map((cv) => cv.id),
    asset_refs: assetRefs,
    issues,
    validation,
  };
  // Sanity check that the payload still matches our zod shape.
  LaunchPayload.parse(payload);

  const insertRow: LaunchPackageInsert = {
    brief_id,
    status: finalOk ? "posted" : "failed",
    payload: payloadToJson(payload) as Json,
  };

  const { data: launch, error: insertErr } = await supabase
    .from("launch_packages")
    .insert(insertRow)
    .select()
    .single();
  if (insertErr || !launch) {
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }

  const evt: EventInsert = {
    kind: finalOk ? "launch_package_posted" : "launch_package_failed",
    ref_table: "launch_packages",
    ref_id: launch.id,
    payload: {
      brief_id,
      issue_count: issues.length,
      validation,
      ...(pipeline_id ? { pipeline_id } : {}),
    } as Json,
  };
  await supabase.from("events").insert(evt);

  // 7. Bidirectional pipeline ↔ launch link.
  //
  // PostgREST doesn't expose a true cross-table transaction from the JS
  // client, so we do this as two soft-failable side-effects: the launch
  // row is the primary artefact. If the back-pointer update fails we log
  // and continue — the launch still exists, the operator can re-link from
  // the UI if needed, and the timeline event below records the intent.
  //
  // Both ops only fire on a clean ``posted`` result. A failed launch
  // would leave the pipeline pointing at junk; better to require the
  // operator to retry once pre-flight passes.
  if (pipeline_id && finalOk) {
    const { error: linkErr } = await supabase
      .from("pipelines")
      .update({ launch_package_id: launch.id })
      .eq("id", pipeline_id);
    if (linkErr) {
      console.warn(
        `[POST /api/launches] failed to back-link pipeline ${pipeline_id} → launch ${launch.id}: ${linkErr.message}`,
      );
    }

    const { error: pevErr } = await supabase.from("pipeline_events").insert({
      pipeline_id,
      kind: "launch_linked",
      stage: "done",
      payload: { launch_package_id: launch.id } as Json,
    });
    if (pevErr) {
      console.warn(
        `[POST /api/launches] failed to emit pipeline_events.launch_linked for ${pipeline_id}: ${pevErr.message}`,
      );
    }
  }

  return NextResponse.json({ launch }, { status: finalOk ? 201 : 422 });
}

/**
 * GET /api/launches
 *
 * Lightweight list endpoint — newest first. Filters: ``?brief_id=<uuid>``,
 * ``?status=<status>``. Archived (soft-deleted) packages are excluded by
 * default; pass ``?archived=true`` to list ONLY the archived set (E5.1 / #595),
 * matching the pipeline-list archived-view convention.
 */
export async function GET(req: NextRequest) {
  const supabase = createAdminClient();
  const url = new URL(req.url);
  const briefId = url.searchParams.get("brief_id");
  const status = url.searchParams.get("status");
  const archived = url.searchParams.get("archived") === "true";

  let query = supabase
    .from("launch_packages")
    .select("id, brief_id, status, created_at, decided_at, decided_notes, payload, deleted_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (archived) query = query.not("deleted_at", "is", null);
  else query = query.is("deleted_at", null);
  if (briefId) query = query.eq("brief_id", briefId);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ launches: data ?? [] });
}
