import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health — public liveness probe.
 *
 * Cheap, unauthenticated, no-side-effects endpoint intended for:
 *   - The Caddy `web` healthcheck (replacing `GET /` which spawns a full
 *     React render every 30s).
 *   - Uptime Robot's external HTTP poll (see
 *     `infra/monitoring/README.md`).
 *   - The CI deploy script's post-rollout smoke test (see
 *     `infra/deploy/smoke.sh`).
 *
 * Body is deliberately minimal but does include `build_sha` so an
 * operator running `curl https://dashboard.<host>/api/health` can tell
 * which image is actually serving traffic — handy after a rollback.
 *
 * The auth-gated counterpart that proxies through to the worker lives at
 * `/api/worker/health`; do not consolidate them — that route requires
 * the worker to be reachable, this one must succeed even if the worker
 * is down (the dashboard process itself is what we're probing).
 *
 * `build_sha` is sourced from `NEXT_PUBLIC_BUILD_SHA` (set at image build
 * time once VPS-10's GH Actions deploy wires it through) or falls back to
 * Vercel's `VERCEL_GIT_COMMIT_SHA`. Until either is wired, "unknown" is
 * the expected value and is not considered an error.
 */
export async function GET() {
  // Treat an empty string as "not set" — CI / Vercel build steps tend to
  // export the var unconditionally and leave it empty when there's no
  // value to inject, which would otherwise short-circuit the fallback.
  const buildSha =
    nonEmpty(process.env.NEXT_PUBLIC_BUILD_SHA) ??
    nonEmpty(process.env.VERCEL_GIT_COMMIT_SHA) ??
    "unknown";

  return NextResponse.json({
    ok: true,
    service: "voxhorizon-web",
    build_sha: buildSha,
    uptime_seconds: process.uptime(),
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
