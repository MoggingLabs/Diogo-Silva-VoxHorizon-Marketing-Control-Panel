import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

function makeRequest(url: string): NextRequest {
  return new NextRequest(new Request(url));
}

describe("/api/approval-mode/audit", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv("WORKER_URL", "http://worker.local");
    vi.stubEnv("VOXHORIZON_APPROVAL_TOKEN", "tok-x");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("returns 503 when worker not configured", async () => {
    vi.stubEnv("WORKER_URL", "");
    const res = await GET(makeRequest("http://localhost/api/approval-mode/audit"));
    expect(res.status).toBe(503);
  });

  it("proxies the worker audit list", async () => {
    const entries = [
      {
        id: "a",
        from_mode: "ASK",
        to_mode: "HALT",
        ttl_seconds: null,
        changed_at: "2026-05-19T00:00:00Z",
        changed_by: "dashboard",
        note: null,
      },
    ];
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ entries }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await GET(makeRequest("http://localhost/api/approval-mode/audit"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].to_mode).toBe("HALT");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://worker.local/work/hermes/approval-mode/audit?limit=50",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer tok-x",
        }),
      }),
    );
  });

  it("forwards a custom limit", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ entries: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await GET(makeRequest("http://localhost/api/approval-mode/audit?limit=10"));
    expect(fetchSpy.mock.calls[0]![0]).toContain("limit=10");
  });

  it("returns 422 on an invalid limit", async () => {
    const res = await GET(makeRequest("http://localhost/api/approval-mode/audit?limit=abc"));
    expect(res.status).toBe(422);
  });

  it("returns 422 on a too-high limit", async () => {
    const res = await GET(makeRequest("http://localhost/api/approval-mode/audit?limit=99999"));
    expect(res.status).toBe(422);
  });

  it("returns 422 on a too-low limit", async () => {
    const res = await GET(makeRequest("http://localhost/api/approval-mode/audit?limit=0"));
    expect(res.status).toBe(422);
  });

  it("surfaces worker non-2xx", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("forbidden", { status: 401 })) as unknown as typeof fetch;
    const res = await GET(makeRequest("http://localhost/api/approval-mode/audit"));
    expect(res.status).toBe(401);
  });

  it("returns 502 on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;
    const res = await GET(makeRequest("http://localhost/api/approval-mode/audit"));
    expect(res.status).toBe(502);
  });

  it("normalises a missing entries field to an empty array", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const res = await GET(makeRequest("http://localhost/api/approval-mode/audit"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual([]);
  });
});
