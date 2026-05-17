/**
 * Tests for `app/api/chat-read-status/route.ts`.
 */
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { POST } from "./route";

function req(body: string | undefined, init: RequestInit = {}): NextRequest {
  return new NextRequest(
    new Request("http://localhost/api/chat-read-status", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      ...init,
    }),
  );
}

describe("POST /api/chat-read-status", () => {
  it("200 with valid body", async () => {
    const res = await POST(
      req(JSON.stringify({ creative_id: "c1", last_read_at: "2026-01-01T00:00:00Z" })),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.persisted).toBe(false);
  });

  it("400 invalid JSON", async () => {
    const res = await POST(req("{"));
    expect(res.status).toBe(400);
  });

  it("400 missing creative_id", async () => {
    const res = await POST(req(JSON.stringify({ last_read_at: "x" })));
    expect(res.status).toBe(400);
  });

  it("400 missing last_read_at", async () => {
    const res = await POST(req(JSON.stringify({ creative_id: "c1" })));
    expect(res.status).toBe(400);
  });
});
