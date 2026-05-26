import { NextResponse, type NextRequest } from "next/server";

import { LaunchDecisionInput, type LaunchPackageUpdate } from "@/lib/launches";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types.gen";

type EventInsert = Database["public"]["Tables"]["events"]["Insert"];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/launches/:id/decision
 *
 * The approval gate for a launch package. Three terminal decisions:
 *   - approved (notes optional)
 *   - approved_with_changes (notes required)
 *   - rejected (notes required)
 *
 * Requirements:
 *   - Launch MUST be in status ``posted`` — else 409.
 *   - For ``approved_with_changes`` / ``rejected``, ``notes`` is required.
 *
 * Side effect: emits ``launch_package_decided`` with the decision +
 * notes preserved in the event payload.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = LaunchDecisionInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { decision, notes } = parsed.data;

  const supabase = createAdminClient();

  const { data: current, error: fetchErr } = await supabase
    .from("launch_packages")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (current.status !== "posted") {
    return NextResponse.json(
      { error: "invalid_state", current: current.status, expected: "posted" },
      { status: 409 },
    );
  }

  const update: LaunchPackageUpdate = {
    status: decision,
    decided_at: new Date().toISOString(),
    decided_notes: notes ?? null,
  };

  const { data: launch, error: updateErr } = await supabase
    .from("launch_packages")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (updateErr || !launch) {
    return NextResponse.json({ error: updateErr?.message ?? "update failed" }, { status: 500 });
  }

  // Silent-failure PR-3 cutover: surface the audit-trail write failure
  // instead of letting it pass silently. The legacy unchecked await let an
  // inserted-but-not-recorded decision diverge from the audit log.
  const evt: EventInsert = {
    kind: "launch_package_decided",
    ref_table: "launch_packages",
    ref_id: launch.id,
    payload: { decision, notes: notes ?? null } as Json,
  };
  const { error: evErr } = await supabase.from("events").insert(evt);
  if (evErr) {
    return NextResponse.json(
      { error: `launch_package_decided event insert failed: ${evErr.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ launch });
}
