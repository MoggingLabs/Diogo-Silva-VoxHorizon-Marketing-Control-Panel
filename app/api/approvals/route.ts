import { NextResponse, type NextRequest } from "next/server";

import { ApprovalsQuery, type Approval } from "@/lib/approvals/types";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SupabaseLike = ReturnType<typeof createAdminClient>;

/**
 * Pull the pipeline id off an approval. The Hermes plugin writes it on
 * `tool_args.pipeline_id` for the operator render and on `context.pipeline_id`
 * for Ekko's image generations — we accept either.
 */
function pipelineIdOf(approval: Approval): string | null {
  const fromArgs = (approval.tool_args as Record<string, unknown> | null)?.pipeline_id;
  if (typeof fromArgs === "string" && fromArgs) return fromArgs;
  const fromCtx = approval.context?.pipeline_id;
  if (typeof fromCtx === "string" && fromCtx) return fromCtx;
  return null;
}

/**
 * Resolve `client_name` for each approval that carries a pipeline id, using
 * exactly two batched queries (no N+1):
 *   1. pipelines WHERE id IN (...)   -> pipeline_id -> client_id
 *   2. clients   WHERE id IN (...)   -> client_id   -> name
 *
 * Returns the approvals with `client_name` + `pipeline_id` attached. Approvals
 * with no pipeline (or an unresolved client) get `client_name: null`. Resolution
 * failures are non-fatal — the list still returns, just without enrichment.
 */
async function enrichWithClients(
  supabase: SupabaseLike,
  approvals: Approval[],
): Promise<Approval[]> {
  const pipelineByApproval = new Map<string, string | null>();
  for (const a of approvals) pipelineByApproval.set(a.id, pipelineIdOf(a));

  const pipelineIds = Array.from(
    new Set(Array.from(pipelineByApproval.values()).filter((v): v is string => Boolean(v))),
  );

  if (pipelineIds.length === 0) {
    return approvals.map((a) => ({ ...a, pipeline_id: pipelineByApproval.get(a.id) ?? null, client_name: null }));
  }

  // 1) pipeline_id -> client_id
  const { data: pipelines, error: pipelinesErr } = await supabase
    .from("pipelines")
    .select("id, client_id")
    .in("id", pipelineIds);

  if (pipelinesErr || !pipelines) {
    return approvals.map((a) => ({ ...a, pipeline_id: pipelineByApproval.get(a.id) ?? null, client_name: null }));
  }

  const clientIdByPipeline = new Map<string, string | null>();
  const clientIds = new Set<string>();
  for (const row of pipelines as Array<{ id: string; client_id: string | null }>) {
    clientIdByPipeline.set(row.id, row.client_id ?? null);
    if (row.client_id) clientIds.add(row.client_id);
  }

  // 2) client_id -> name
  const nameByClient = new Map<string, string>();
  if (clientIds.size > 0) {
    const { data: clients, error: clientsErr } = await supabase
      .from("clients")
      .select("id, name")
      .in("id", Array.from(clientIds));
    if (!clientsErr && clients) {
      for (const row of clients as Array<{ id: string; name: string | null }>) {
        if (row.name) nameByClient.set(row.id, row.name);
      }
    }
  }

  return approvals.map((a) => {
    const pid = pipelineByApproval.get(a.id) ?? null;
    const clientId = pid ? (clientIdByPipeline.get(pid) ?? null) : null;
    const clientName = clientId ? (nameByClient.get(clientId) ?? null) : null;
    return { ...a, pipeline_id: pid, client_name: clientName };
  });
}

/**
 * GET /api/approvals
 *
 * Lists approvals from the `approvals` table. Defaults to "pending only" so
 * the queue widget is cheap to mount and the dashboard's auto-poll fallback
 * is a no-op when nothing's outstanding.
 *
 * Query string (all optional, see `lib/approvals/types.ts`):
 *   - status         — `pending|decided|expired|cancelled` (default: pending)
 *   - session        — filter to a single `ekko_session_id`
 *   - tool           — filter to a single `tool_name`
 *   - decision       — filter (only meaningful when status='decided')
 *   - from / to      — ISO timestamps; filter on `requested_at`
 *   - limit          — page size (default 100, max 500)
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const queryRaw: Record<string, unknown> = {};
  for (const k of ["status", "session", "tool", "decision", "from", "to", "limit"] as const) {
    const v = url.searchParams.get(k);
    if (v !== null) queryRaw[k] = v;
  }
  const parsed = ApprovalsQuery.safeParse(queryRaw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const { status, session, tool, decision, from, to, limit } = parsed.data;
  const effectiveStatus = status ?? "pending";

  const supabase = createAdminClient();
  let q = supabase
    .from("approvals")
    .select("*")
    .order("requested_at", { ascending: false })
    .limit(limit);

  q = q.eq("status", effectiveStatus);
  if (session) q = q.eq("ekko_session_id", session);
  if (tool) q = q.eq("tool_name", tool);
  if (decision) q = q.eq("decision", decision);
  if (from) q = q.gte("requested_at", from);
  if (to) q = q.lte("requested_at", to);

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const approvals = await enrichWithClients(supabase, (data ?? []) as Approval[]);
  return NextResponse.json({ approvals });
}
