import { NextResponse, type NextRequest } from "next/server";

import { ApprovalModeInput, type ApprovalModeState } from "@/lib/approval-mode/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolve ``(workerUrl, token)`` from env or return ``null`` when either is
 * missing. Mirrors the pattern used by the existing worker pass-throughs
 * (see ``app/api/pipelines/[id]/advance/route.ts::fireWorkerIdeation``) —
 * when the worker isn't wired up locally, the route surfaces 503 instead
 * of crashing.
 */
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
 * GET /api/approval-mode
 *
 * Pass-through to the worker's ``GET /work/hermes/approval-mode``. Returns
 * the singleton ``approval_mode`` row.
 */
export async function GET() {
  const wire = resolveWorker();
  if (!wire) {
    return NextResponse.json({ error: "worker_not_configured" }, { status: 503 });
  }
  try {
    const res = await fetch(`${wire.base}/work/hermes/approval-mode`, {
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
    const body = (await res.json()) as ApprovalModeState;
    return NextResponse.json(body);
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

/**
 * PUT /api/approval-mode
 *
 * Body: ``{ mode, ttl_seconds?, note? }``. Validates the shape with the
 * shared ``ApprovalModeInput`` schema, then proxies to the worker. The
 * worker enforces the cross-field invariants again, so a stale client
 * can't bypass the rules.
 */
export async function PUT(req: NextRequest) {
  const wire = resolveWorker();
  if (!wire) {
    return NextResponse.json({ error: "worker_not_configured" }, { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = ApprovalModeInput.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  try {
    const res = await fetch(`${wire.base}/work/hermes/approval-mode`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${wire.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: parsed.data.mode,
        ttl_seconds: parsed.data.ttl_seconds ?? null,
        note: parsed.data.note ?? null,
        changed_by: "dashboard",
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `worker ${res.status}`, detail: text.slice(0, 500) },
        { status: res.status },
      );
    }
    const body = (await res.json()) as ApprovalModeState;
    return NextResponse.json(body);
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
