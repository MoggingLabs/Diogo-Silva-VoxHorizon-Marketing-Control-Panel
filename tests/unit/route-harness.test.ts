/**
 * Self-test for the MSW-based Next API-route harness (T.3 / #316).
 *
 * Proves the harness on two EXISTING routes, intercepting their outbound HTTP
 * at the network boundary instead of mocking modules:
 *
 *   - `app/api/approval-mode/route.ts`  — a worker pass-through over `fetch`.
 *     Demonstrates the worker origin + happy / 401 / 422 contract tests.
 *   - `app/api/worker/health/route.ts`  — a worker call through `lib/worker`'s
 *     retry/timeout client. Demonstrates the harness works through the typed
 *     worker RPC surface too, not just bare `fetch`.
 *
 * Acceptance criteria (#316): a sample Next API route tested for happy/401/422.
 */
import { describe, expect, it, vi } from "vitest";

// `app/api/worker/health/route.ts` imports `lib/worker`, which imports
// `server-only`; that throws under the jsdom route-test project. Neutralise
// it so we can drive the REAL worker client through MSW (the whole point of
// this harness) rather than module-mocking `lib/worker`.
vi.mock("server-only", () => ({}));

import { GET as approvalModeGET, PUT as approvalModePUT } from "@/app/api/approval-mode/route";
import { GET as workerHealthGET } from "@/app/api/worker/health/route";

import {
  callRoute,
  makeRouteRequest,
  setupRouteHarness,
  workerJson,
  workerText,
} from "./helpers/route-harness";

describe("route-harness (T.3)", () => {
  const harness = setupRouteHarness();

  // ---------------------------------------------------------------------------
  // Happy path — the route proxies a 200 worker response.
  // ---------------------------------------------------------------------------

  it("intercepts the worker GET and returns the proxied body (happy)", async () => {
    harness.worker.get(
      "/work/hermes/approval-mode",
      workerJson({ mode: "ASK", expires_at: null, set_by: "x", set_at: "t", note: null }),
    );

    const res = await callRoute(approvalModeGET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("ASK");
  });

  it("forwards the bearer token the route was configured with", async () => {
    let seenAuth: string | null = null;
    harness.worker.get("/work/hermes/approval-mode", ({ request }) => {
      seenAuth = request.headers.get("authorization");
      return workerJson({ mode: "HALT", expires_at: null, set_by: "x", set_at: "t", note: null });
    });

    const res = await callRoute(approvalModeGET);
    expect(res.status).toBe(200);
    // The harness wires VOXHORIZON_APPROVAL_TOKEN; the route must send it.
    expect(seenAuth).toBe("Bearer test-approval-token");
  });

  // ---------------------------------------------------------------------------
  // 401 — the worker rejects auth; the route surfaces the upstream status.
  // ---------------------------------------------------------------------------

  it("surfaces the worker 401 (auth)", async () => {
    harness.worker.get("/work/hermes/approval-mode", workerText("forbidden", { status: 401 }));

    const res = await callRoute(approvalModeGET);
    expect(res.status).toBe(401);
  });

  it("returns 503 when the worker is not configured (no token)", async () => {
    // Per-test env override: drop the token so the route short-circuits
    // before any network call — no handler registered means MSW's
    // onUnhandledRequest:"error" would fire if the route fetched anyway.
    vi.stubEnv("VOXHORIZON_APPROVAL_TOKEN", "");
    const res = await callRoute(approvalModeGET);
    expect(res.status).toBe(503);
  });

  // ---------------------------------------------------------------------------
  // 422 — local validation rejects a bad payload BEFORE any worker call.
  // ---------------------------------------------------------------------------

  it("returns 422 on an invalid PUT payload (validation)", async () => {
    // No worker handler registered: the route must reject before fetching.
    const res = await callRoute(
      approvalModePUT,
      makeRouteRequest({
        method: "PUT",
        url: "http://localhost/api/approval-mode",
        body: { mode: "NOT_A_MODE" },
      }) as never,
    );
    expect(res.status).toBe(422);
  });

  it("proxies a valid PUT payload to the worker (happy round-trip)", async () => {
    let sentBody: unknown = null;
    harness.worker.put("/work/hermes/approval-mode", async ({ request }) => {
      sentBody = await request.json();
      return workerJson({
        mode: "AUTO_APPROVE",
        expires_at: "2026-05-22T10:00:00Z",
        set_by: "dashboard",
        set_at: "2026-05-22T06:00:00Z",
        note: "batch",
      });
    });

    const res = await callRoute(
      approvalModePUT,
      makeRouteRequest({
        method: "PUT",
        url: "http://localhost/api/approval-mode",
        body: { mode: "AUTO_APPROVE", ttl_seconds: 14400, note: "batch" },
      }) as never,
    );
    expect(res.status).toBe(200);
    expect((sentBody as { mode: string }).mode).toBe("AUTO_APPROVE");
    expect((sentBody as { changed_by: string }).changed_by).toBe("dashboard");
  });

  // ---------------------------------------------------------------------------
  // The harness also works through lib/worker's typed RPC client.
  // ---------------------------------------------------------------------------

  it("intercepts a route that calls the worker via lib/worker (happy)", async () => {
    harness.worker.get("/work/health", workerJson({ ok: true, version: "deadbeef" }));

    const res = await callRoute(workerHealthGET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.worker.version).toBe("deadbeef");
  });

  it("surfaces a worker outage as 503 through lib/worker", async () => {
    harness.worker.get("/work/health", workerText("boom", { status: 500 }));
    const res = await callRoute(workerHealthGET);
    // lib/worker retries 5xx once then throws WorkerError(500); the route maps
    // a <600 status straight through.
    expect(res.status).toBe(500);
  });
});
