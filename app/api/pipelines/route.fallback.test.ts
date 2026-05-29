/**
 * Focused coverage for the route's error-mapping FALLBACK branch.
 *
 * The thin HTTP wrappers catch anything thrown by the data layer and map it to
 * a 500. The data layer always throws an `Error`, so the `err instanceof Error`
 * false-branch (the literal-string fallback) is only reachable if a non-Error
 * value is thrown. We mock `@/lib/pipeline/queries` here to throw a plain
 * string and assert the fallback message lands.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listPipelinesQuery = vi.fn();
const createPipelineRecord = vi.fn();

vi.mock("@/lib/pipeline/queries", () => ({
  listPipelinesQuery: (...args: unknown[]) => listPipelinesQuery(...args),
  createPipelineRecord: (...args: unknown[]) => createPipelineRecord(...args),
}));

import { GET, POST } from "./route";

function makeRequest(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("GET /api/pipelines error fallback", () => {
  beforeEach(() => {
    listPipelinesQuery.mockReset();
  });

  it("maps a non-Error rejection to a 500 with the fallback message", async () => {
    listPipelinesQuery.mockRejectedValueOnce("plain string failure");
    const res = await GET(makeRequest("http://localhost/api/pipelines"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("list failed");
  });
});

describe("POST /api/pipelines error fallback", () => {
  beforeEach(() => {
    createPipelineRecord.mockReset();
  });

  it("maps a non-Error rejection to a 500 with the fallback message", async () => {
    createPipelineRecord.mockRejectedValueOnce("plain string failure");
    const res = await POST(
      makeRequest("http://localhost/api/pipelines", {
        method: "POST",
        body: JSON.stringify({ format_choice: "image" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("insert failed");
  });
});
