/**
 * Tests for `app/api/health/route.ts`.
 *
 * The endpoint is intentionally trivial — pure JSON with no external
 * dependencies — so the suite focuses on the response shape and on the
 * `build_sha` resolution order, which is the one piece of behaviour
 * downstream operators rely on (it tells them which image is serving
 * traffic after a rollback).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

describe("GET /api/health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 200 with the expected shape", async () => {
    vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      service: "voxhorizon-web",
    });
    expect(typeof body.build_sha).toBe("string");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it("falls back to 'unknown' when no build SHA env is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");

    const res = await GET();
    const body = await res.json();
    expect(body.build_sha).toBe("unknown");
  });

  it("uses NEXT_PUBLIC_BUILD_SHA when set", async () => {
    vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", "abc1234");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "should-not-win");

    const res = await GET();
    const body = await res.json();
    expect(body.build_sha).toBe("abc1234");
  });

  it("falls back to VERCEL_GIT_COMMIT_SHA when NEXT_PUBLIC_BUILD_SHA is absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "vercel-sha-1");

    const res = await GET();
    const body = await res.json();
    expect(body.build_sha).toBe("vercel-sha-1");
  });
});
