import { NextResponse } from "next/server";

import { worker, WorkerError } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Health-check proxy: pings the worker's `/work/health` endpoint and surfaces
 * its response. Returns 503 with a structured error if the worker is
 * unreachable, timed out, or returns a non-2xx status.
 */
export async function GET() {
  try {
    const data = await worker.health();
    return NextResponse.json({ ok: true, worker: data });
  } catch (err) {
    const message =
      err instanceof WorkerError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unknown worker error";
    const status =
      err instanceof WorkerError && err.status && err.status < 600
        ? err.status
        : 503;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
