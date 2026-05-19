import { NextResponse, type NextRequest } from "next/server";

import type { ApprovalModeAuditEntry } from "@/lib/approval-mode/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function resolveWorker(): { base: string; token: string } | null {
  const baseRaw = process.env.WORKER_URL;
  const tokenRaw = process.env.VOXHORIZON_APPROVAL_TOKEN;
  if (!baseRaw || !tokenRaw) return null;
  return {
    base: baseRaw.replace(/\/$/, ""),
    token: tokenRaw.trim(),
  };
}

/**
 * GET /api/approval-mode/audit?limit=N
 *
 * Pass-through to ``GET /work/hermes/approval-mode/audit``. Returns the
 * ``approval_mode_audit`` rows newest-first.
 */
export async function GET(req: NextRequest) {
  const wire = resolveWorker();
  if (!wire) {
    return NextResponse.json({ error: "worker_not_configured" }, { status: 503 });
  }
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return NextResponse.json(
        { error: "invalid limit", detail: `limit must be 1..${MAX_LIMIT}` },
        { status: 422 },
      );
    }
    limit = parsed;
  }

  try {
    const res = await fetch(`${wire.base}/work/hermes/approval-mode/audit?limit=${limit}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${wire.token}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `worker ${res.status}`, detail: text.slice(0, 200) },
        { status: res.status },
      );
    }
    const body = (await res.json()) as { entries: ApprovalModeAuditEntry[] };
    return NextResponse.json({ entries: body.entries ?? [] });
  } catch (err) {
    return NextResponse.json(
      {
        error: "worker_unreachable",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}
