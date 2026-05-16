import { NextResponse, type NextRequest } from "next/server";

import {
  UpdateBriefInput,
  canTransition,
  transitionEventKind,
  type BriefStatusT,
  type BriefUpdate,
} from "@/lib/briefs";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types.gen";

type EventInsert = Database["public"]["Tables"]["events"]["Insert"];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/briefs/:id
 *
 * Single-brief fetch. Returns 404 if the row is missing. Includes the brief
 * plus its event timeline (most recent 200 events for that brief, oldest
 * first) so a client can render the row + history in one round-trip.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const { data: brief, error } = await supabase
    .from("briefs")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!brief) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data: events, error: evErr } = await supabase
    .from("events")
    .select("id, kind, payload, created_at, ref_table, ref_id")
    .eq("ref_table", "briefs")
    .eq("ref_id", id)
    .order("created_at", { ascending: true })
    .limit(200);

  if (evErr) {
    return NextResponse.json({ error: evErr.message }, { status: 500 });
  }

  return NextResponse.json({ brief, events: events ?? [] });
}

/**
 * PATCH /api/briefs/:id
 *
 * Two orthogonal mutations, either or both:
 *   - `payload`: replace the jsonb payload (server-side schema validated).
 *   - `status`: request a transition. Enforced by `canTransition()` — any
 *     disallowed transition returns 409 with the current state attached.
 *
 * Side effects:
 *   - On `draft -> posted`, sets `posted_at` to `now()`.
 *   - On any transition, emits `events.kind = brief_<from>_to_<to>`.
 *
 * Decisions (`approved`/`approved_with_changes`/`rejected`) require notes
 * and live in `POST /api/briefs/:id/approve` — not here. Calling PATCH
 * with one of those statuses without going through the approval route is
 * still allowed in principle (state machine permits it), but no notes are
 * collected; the approval route is the operator-facing path.
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = UpdateBriefInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  const { data: current, error: fetchErr } = await supabase
    .from("briefs")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  const update: BriefUpdate = {};
  const fromStatus = current.status as BriefStatusT;
  let toStatus: BriefStatusT | null = null;

  if (parsed.data.payload) {
    update.payload = parsed.data.payload as unknown as Json;
  }
  if (parsed.data.status && parsed.data.status !== fromStatus) {
    if (!canTransition(fromStatus, parsed.data.status)) {
      return NextResponse.json(
        {
          error: "invalid_transition",
          from: fromStatus,
          to: parsed.data.status,
        },
        { status: 409 },
      );
    }
    toStatus = parsed.data.status;
    update.status = toStatus;
    if (fromStatus === "draft" && toStatus === "posted") {
      update.posted_at = new Date().toISOString();
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const { data: brief, error: updateErr } = await supabase
    .from("briefs")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (updateErr || !brief) {
    return NextResponse.json({ error: updateErr?.message ?? "update failed" }, { status: 500 });
  }

  const eventRows: EventInsert[] = [];
  if (toStatus) {
    eventRows.push({
      kind: transitionEventKind(fromStatus, toStatus),
      ref_table: "briefs",
      ref_id: brief.id,
      payload: { from: fromStatus, to: toStatus } as Json,
    });
  }
  if (parsed.data.payload) {
    eventRows.push({
      kind: "brief_payload_updated",
      ref_table: "briefs",
      ref_id: brief.id,
      payload: null,
    });
  }
  if (eventRows.length > 0) {
    const { error: evErr } = await supabase.from("events").insert(eventRows);
    if (evErr) {
      console.warn(`[briefs.patch] event insert failed: ${evErr.message}`);
    }
  }

  return NextResponse.json({ brief });
}
