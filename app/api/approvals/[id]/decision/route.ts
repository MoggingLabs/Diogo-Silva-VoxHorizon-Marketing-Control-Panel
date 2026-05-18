import { NextResponse, type NextRequest } from "next/server";

import { DecisionInput } from "@/lib/approvals/types";
import { hashToolArgs } from "@/lib/approvals/canonical-json";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const DEFAULT_CACHE_MINUTES = 240;

/**
 * POST /api/approvals/:id/decision
 *
 * Body:
 *   {
 *     decision: 'approved' | 'rejected' | 'approved_with_caveat',
 *     notes?: string,
 *     cache_for_session?: boolean,
 *     cache_for_minutes?: number,
 *   }
 *
 * Behaviour:
 *   1. Validate the body via `DecisionInput`.
 *   2. UPDATE `approvals` WHERE id=? AND status='pending' — idempotent:
 *      a second POST returns 409 with the row's current state.
 *   3. If `cache_for_session = true`, insert into `approvals_policy_cache`
 *      with `tool_args_hash = SHA-256(canonical_json(tool_args))` and an
 *      expiry of `now() + cache_for_minutes` (defaults to 4h).
 *
 * Auth: matches the rest of the dashboard — single-operator behind
 * Tailscale, no per-user auth yet. The route accepts any caller; the row
 * is updated with `decided_by='dashboard'` so the audit trail still
 * shows the source. When the SSO layer lands (Wave 24) this is the
 * place to plug it in.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = DecisionInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const { decision, notes, cache_for_session, cache_for_minutes } = parsed.data;

  const supabase = createAdminClient();
  // Cast to `any`: until Wave 22 regenerates the types, the `approvals`
  // table is not in the schema so column-name checks would reject these
  // operations.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAny: any = supabase;

  // Idempotency guard: only update when still pending. If the WHERE clause
  // matches nothing, the row either does not exist OR has already been
  // decided/cancelled — we read it back to disambiguate.
  const decided_at = new Date().toISOString();
  const { data: updateData, error: updateErr } = await supabaseAny
    .from("approvals")
    .update({
      status: "decided",
      decision,
      decided_by: "dashboard",
      decided_at,
      decision_notes: notes ?? null,
      cache_for_session: cache_for_session ?? false,
      cache_for_minutes: cache_for_session ? (cache_for_minutes ?? DEFAULT_CACHE_MINUTES) : null,
    })
    .eq("id", id)
    .eq("status", "pending")
    .select()
    .maybeSingle();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }
  if (!updateData) {
    // Either the row is missing or it's already been decided. Re-read so we
    // can return the right status code + the current state.
    const { data: existing, error: readErr } = await supabaseAny
      .from("approvals")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (readErr) {
      return NextResponse.json({ error: readErr.message }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "already_decided", approval: existing }, { status: 409 });
  }

  // Cache the decision on the operator's "approve and remember" toggle.
  // We only write the cache when:
  //   - cache_for_session is true
  //   - the row carries a usable session id + tool name + tool_args
  if (cache_for_session) {
    const row = updateData as {
      ekko_session_id?: string;
      tool_name?: string;
      tool_args?: Record<string, unknown>;
    };
    if (row.ekko_session_id && row.tool_name && row.tool_args !== undefined) {
      const minutes = cache_for_minutes ?? DEFAULT_CACHE_MINUTES;
      const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
      const cacheRow = {
        ekko_session_id: row.ekko_session_id,
        tool_name: row.tool_name,
        tool_args_hash: hashToolArgs(row.tool_args),
        decision,
        expires_at: expiresAt,
      };
      const { error: cacheErr } = await supabaseAny.from("approvals_policy_cache").insert(cacheRow);
      if (cacheErr) {
        // Cache write is best-effort — log and keep the 200 because the
        // approval row update is the primary artifact.
        console.warn(`[approvals.decision] cache insert failed: ${cacheErr.message}`);
      }
    }
  }

  return NextResponse.json({ approval: updateData });
}
