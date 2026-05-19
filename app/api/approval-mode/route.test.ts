import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, PUT } from "./route";

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("/api/approval-mode", () => {
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

  // -------------------------------------------------------------------------
  // GET
  // -------------------------------------------------------------------------

  it("GET returns 503 when worker not configured", async () => {
    vi.stubEnv("WORKER_URL", "");
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it("GET returns 503 when token missing", async () => {
    vi.stubEnv("VOXHORIZON_APPROVAL_TOKEN", "");
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it("GET proxies the worker response", async () => {
    const payload = {
      mode: "ASK",
      expires_at: null,
      set_by: "dashboard",
      set_at: "2026-05-19T00:00:00Z",
      note: null,
    };
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("ASK");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://worker.local/work/hermes/approval-mode",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer tok-x",
        }),
      }),
    );
  });

  it("GET surfaces worker non-2xx", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("forbidden", { status: 401 })) as unknown as typeof fetch;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("GET returns 502 on network failure", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toContain("network down");
  });

  // -------------------------------------------------------------------------
  // PUT
  // -------------------------------------------------------------------------

  it("PUT returns 503 when worker not configured", async () => {
    vi.stubEnv("WORKER_URL", "");
    const res = await PUT(
      makeRequest("http://localhost/api/approval-mode", {
        method: "PUT",
        body: JSON.stringify({ mode: "HALT" }),
      }),
    );
    expect(res.status).toBe(503);
  });

  it("PUT returns 400 on invalid JSON", async () => {
    const res = await PUT(
      makeRequest("http://localhost/api/approval-mode", {
        method: "PUT",
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("PUT returns 422 on unknown mode", async () => {
    const res = await PUT(
      makeRequest("http://localhost/api/approval-mode", {
        method: "PUT",
        body: JSON.stringify({ mode: "NOPE" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("PUT returns 422 when AUTO_APPROVE missing ttl_seconds", async () => {
    const res = await PUT(
      makeRequest("http://localhost/api/approval-mode", {
        method: "PUT",
        body: JSON.stringify({ mode: "AUTO_APPROVE" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("PUT returns 422 when ASK has ttl_seconds", async () => {
    const res = await PUT(
      makeRequest("http://localhost/api/approval-mode", {
        method: "PUT",
        body: JSON.stringify({ mode: "ASK", ttl_seconds: 3600 }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("PUT returns 422 when ttl_seconds below minimum", async () => {
    const res = await PUT(
      makeRequest("http://localhost/api/approval-mode", {
        method: "PUT",
        body: JSON.stringify({ mode: "AUTO_APPROVE", ttl_seconds: 1 }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("PUT proxies a valid payload to the worker", async () => {
    const payload = {
      mode: "AUTO_APPROVE",
      expires_at: "2026-05-19T10:00:00Z",
      set_by: "dashboard",
      set_at: "2026-05-19T06:00:00Z",
      note: "batch",
    };
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await PUT(
      makeRequest("http://localhost/api/approval-mode", {
        method: "PUT",
        body: JSON.stringify({
          mode: "AUTO_APPROVE",
          ttl_seconds: 14400,
          note: "batch",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("AUTO_APPROVE");

    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe("http://worker.local/work/hermes/approval-mode");
    expect((call[1] as RequestInit).method).toBe("PUT");
    const sentBody = JSON.parse((call[1] as RequestInit).body as string);
    expect(sentBody.mode).toBe("AUTO_APPROVE");
    expect(sentBody.ttl_seconds).toBe(14400);
    expect(sentBody.note).toBe("batch");
    expect(sentBody.changed_by).toBe("dashboard");
  });

  it("PUT surfaces worker non-2xx", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 502 })) as unknown as typeof fetch;
    const res = await PUT(
      makeRequest("http://localhost/api/approval-mode", {
        method: "PUT",
        body: JSON.stringify({ mode: "HALT" }),
      }),
    );
    expect(res.status).toBe(502);
  });

  it("PUT returns 502 on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;
    const res = await PUT(
      makeRequest("http://localhost/api/approval-mode", {
        method: "PUT",
        body: JSON.stringify({ mode: "HALT" }),
      }),
    );
    expect(res.status).toBe(502);
  });

  it("PUT strips trailing slash from worker URL", async () => {
    vi.stubEnv("WORKER_URL", "http://worker.local/");
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          mode: "HALT",
          expires_at: null,
          set_by: "dashboard",
          set_at: "x",
          note: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await PUT(
      makeRequest("http://localhost/api/approval-mode", {
        method: "PUT",
        body: JSON.stringify({ mode: "HALT" }),
      }),
    );
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://worker.local/work/hermes/approval-mode");
  });
});
