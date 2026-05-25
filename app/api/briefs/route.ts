import { NextResponse, type NextRequest } from "next/server";

import { CreateBriefInput, type BriefInsert } from "@/lib/briefs";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types.gen";

type EventInsert = Database["public"]["Tables"]["events"]["Insert"];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/briefs
 *
 * Lists briefs ordered by `created_at desc`. Optional `?status=<status>` and
 * `?client_id=<uuid>` filters. Active rows only by default (`deleted_at is
 * null`); pass `?archived=1` to list archived rows or `?archived=all` to
 * include both. Intended for the index page and lightweight client-side
 * lookups — not paginated yet (volume is small in v1).
 */
export async function GET(req: NextRequest) {
  const supabase = createAdminClient();
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const clientId = url.searchParams.get("client_id");
  const archived = url.searchParams.get("archived");

  let query = supabase
    .from("briefs")
    .select(
      "id, brief_id_human, client_id, status, payload, created_at, posted_at, decided_at, deleted_at",
    )
    .order("created_at", { ascending: false })
    .limit(200);

  if (archived === "1" || archived === "true") {
    query = query.not("deleted_at", "is", null);
  } else if (archived !== "all") {
    query = query.is("deleted_at", null);
  }

  if (status) {
    query = query.eq(
      "status",
      status as "draft" | "posted" | "approved" | "approved_with_changes" | "rejected",
    );
  }
  if (clientId) query = query.eq("client_id", clientId);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ briefs: data ?? [] });
}

/**
 * POST /api/briefs
 *
 * Creates a new brief. By default the row lands in `draft`; pass `?post=1`
 * to insert directly as `posted` (skipping the explicit "save draft → post"
 * round-trip when the operator is sure).
 *
 * Side effects:
 *   1. Mints `brief_id_human` via the `gen_brief_id_human(slug)` RPC.
 *   2. Inserts the briefs row.
 *   3. Emits a `brief_created` (and on `?post=1`, an additional
 *      `brief_draft_to_posted`) row into `events`.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = CreateBriefInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { client_id, payload } = parsed.data;
  const supabase = createAdminClient();

  // Look up the client slug — required input for the human-id generator.
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("slug")
    .eq("id", client_id)
    .maybeSingle();

  if (clientErr) {
    return NextResponse.json({ error: clientErr.message }, { status: 500 });
  }
  if (!client) {
    return NextResponse.json({ error: "client not found" }, { status: 404 });
  }

  const { data: humanIdRpc, error: rpcErr } = await supabase.rpc("gen_brief_id_human", {
    p_client_slug: client.slug,
  });
  if (rpcErr || !humanIdRpc) {
    return NextResponse.json(
      { error: rpcErr?.message ?? "failed to mint brief_id_human" },
      { status: 500 },
    );
  }

  const shouldPost = new URL(req.url).searchParams.get("post") === "1";
  const now = new Date().toISOString();
  const insert: BriefInsert = {
    brief_id_human: humanIdRpc,
    client_id,
    payload: payload as unknown as Json,
    status: shouldPost ? "posted" : "draft",
    posted_at: shouldPost ? now : null,
  };

  const { data: brief, error: insertErr } = await supabase
    .from("briefs")
    .insert(insert)
    .select()
    .single();

  if (insertErr || !brief) {
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }

  // Emit lifecycle events. We deliberately keep this inline (no shared
  // `lib/events.ts` helper yet — coordinated with Agent Y to avoid a
  // simultaneous-write collision; will be consolidated later).
  const eventRows: EventInsert[] = [
    {
      kind: "brief_created",
      ref_table: "briefs",
      ref_id: brief.id,
      payload: { brief_id_human: brief.brief_id_human, client_id } as Json,
    },
  ];
  if (shouldPost) {
    eventRows.push({
      kind: "brief_draft_to_posted",
      ref_table: "briefs",
      ref_id: brief.id,
      payload: { brief_id_human: brief.brief_id_human } as Json,
    });
  }
  const { error: evErr } = await supabase.from("events").insert(eventRows);
  if (evErr) {
    // Don't fail the request — the brief is real and primary. Log + continue.
    console.warn(`[briefs.create] event insert failed: ${evErr.message}`);
  }

  return NextResponse.json({ brief }, { status: 201 });
}
