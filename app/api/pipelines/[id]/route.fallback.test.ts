/**
 * Focused coverage for the GET route's error-mapping FALLBACK branch.
 *
 * The thin HTTP wrapper catches anything thrown by `getPipelineQuery` and maps
 * it to a 500. The data layer always throws an `Error`, so the
 * `err instanceof Error` false-branch (the literal-string fallback) is only
 * reachable if a non-Error value is thrown. We mock the query here to throw a
 * plain string and assert the fallback message lands.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getPipelineQuery = vi.fn();
vi.mock("@/lib/pipeline/queries", () => ({
  getPipelineQuery: (...args: unknown[]) => getPipelineQuery(...args),
}));

import { GET } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(url: string): NextRequest {
  return new NextRequest(new Request(url));
}

describe("GET /api/pipelines/:id error fallback", () => {
  beforeEach(() => {
    getPipelineQuery.mockReset();
  });

  it("maps a non-Error rejection to a 500 with the fallback message", async () => {
    getPipelineQuery.mockRejectedValueOnce("plain string failure");
    const res = await GET(req(`http://localhost/api/pipelines/${id}`), { params });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("fetch failed");
  });
});
