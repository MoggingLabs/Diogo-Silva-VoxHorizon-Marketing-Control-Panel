import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelPipeline,
  createLaunchPackage,
  createPipeline,
  getPipeline,
  kickoffOperatorPipeline,
  listPipelines,
  submitReviewDecision,
  updatePicks,
} from "./client";
import { jsonResponse, spyOnFetch, textResponse } from "@/tests/unit/helpers/worker-mock";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  // Force server-side branch (typeof window !== "undefined" is false in
  // node). Reset env vars so resolveBaseUrl is deterministic.
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.VERCEL_URL;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  vi.restoreAllMocks();
});

describe("createPipeline", () => {
  it("posts the body and returns the new pipeline", async () => {
    const spy = spyOnFetch();
    const pipeline = { id: "p1", status: "configuration", format_choice: "image" };
    spy.mockResolvedValueOnce(jsonResponse({ pipeline }));
    const out = await createPipeline({ format_choice: "image" });
    expect(out).toEqual(pipeline);
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe("http://localhost:3000/api/pipelines");
    expect((call?.[1] as RequestInit | undefined)?.method).toBe("POST");
  });

  it("uses NEXT_PUBLIC_APP_URL when set", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ pipeline: { id: "p1" } }));
    await createPipeline({ format_choice: "image" });
    expect(spy.mock.calls[0]?.[0]).toBe("https://app.example.com/api/pipelines");
  });

  it("uses VERCEL_URL fallback", async () => {
    process.env.VERCEL_URL = "preview.vercel.app";
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ pipeline: { id: "p1" } }));
    await createPipeline({ format_choice: "image" });
    expect(spy.mock.calls[0]?.[0]).toBe("https://preview.vercel.app/api/pipelines");
  });

  it("throws when the response is not 2xx", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("bad body", { status: 400 }));
    await expect(createPipeline({ format_choice: "image" })).rejects.toThrow(/400.*bad body/);
  });

  it("throws when JSON is malformed", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(textResponse("not json"));
    await expect(createPipeline({ format_choice: "image" })).rejects.toThrow(/Invalid JSON/);
  });

  it("throws using statusText when body is empty", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("", { status: 500, statusText: "Server bad" }));
    await expect(createPipeline({ format_choice: "image" })).rejects.toThrow(/500.*Server bad/);
  });
});

describe("kickoffOperatorPipeline", () => {
  it("posts the instruction to the operator route and returns the pipeline", async () => {
    const spy = spyOnFetch();
    const pipeline = { id: "op1", status: "configuration", format_choice: "image" };
    spy.mockResolvedValueOnce(jsonResponse({ pipeline }));
    const out = await kickoffOperatorPipeline({ instruction: "4 roofing ads, Austin" });
    expect(out).toEqual(pipeline);
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe("http://localhost:3000/api/pipelines/operator");
    const init = call?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ instruction: "4 roofing ads, Austin" });
  });

  it("throws with the inline body on a non-2xx", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("nope", { status: 422 }));
    await expect(kickoffOperatorPipeline({ instruction: "x" })).rejects.toThrow(/422.*nope/);
  });
});

describe("listPipelines", () => {
  it("encodes filter params into the query string", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ pipelines: [], next_cursor: null }));
    await listPipelines({
      status: "ideation",
      client_id: "c1",
      limit: 10,
      cursor: "2026-05-17T00:00:00Z",
    });
    const url = spy.mock.calls[0]?.[0] as string;
    expect(url).toContain("status=ideation");
    expect(url).toContain("client_id=c1");
    expect(url).toContain("limit=10");
    expect(url).toContain("cursor=");
  });

  it("works with no filters at all", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ pipelines: [], next_cursor: null }));
    await listPipelines();
    expect(spy.mock.calls[0]?.[0]).toBe("http://localhost:3000/api/pipelines");
  });

  it("throws on non-2xx", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("upstream", { status: 502 }));
    await expect(listPipelines()).rejects.toThrow(/502.*upstream/);
  });

  it("falls back to statusText when the body is empty", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("", { status: 500, statusText: "Boom" }));
    await expect(listPipelines()).rejects.toThrow(/500.*Boom/);
  });
});

describe("getPipeline", () => {
  it("returns the parsed body", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(
      jsonResponse({ pipeline: { id: "p1" }, image_brief: null, video_brief: null, events: [] }),
    );
    const out = await getPipeline("p1");
    expect(out.pipeline.id).toBe("p1");
  });

  it("throws a 404 with a status property", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(getPipeline("p1")).rejects.toMatchObject({
      message: "Pipeline not found",
      status: 404,
    });
  });

  it("throws on other non-2xx", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("err", { status: 500 }));
    await expect(getPipeline("p1")).rejects.toThrow(/500/);
  });

  it("falls back to statusText when body is empty", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("", { status: 500, statusText: "Boom" }));
    await expect(getPipeline("p1")).rejects.toThrow(/Boom/);
  });

  it("encodes special characters in the id", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(
      jsonResponse({ pipeline: { id: "a b" }, image_brief: null, video_brief: null, events: [] }),
    );
    await getPipeline("a b");
    expect(spy.mock.calls[0]?.[0]).toContain("a%20b");
  });
});

describe("updatePicks", () => {
  it("posts picks JSON", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("", { status: 200 }));
    await updatePicks("p1", { image: ["a"], video: [] });
    const call = spy.mock.calls[0];
    expect(call?.[0]).toContain("/api/pipelines/p1/picks");
    expect((call?.[1] as RequestInit | undefined)?.method).toBe("POST");
  });

  it("throws on non-2xx", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("bad", { status: 400 }));
    await expect(updatePicks("p1", {})).rejects.toThrow(/400.*bad/);
  });

  it("falls back to statusText when body is empty", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("", { status: 500, statusText: "X" }));
    await expect(updatePicks("p1", {})).rejects.toThrow(/X/);
  });
});

describe("createLaunchPackage", () => {
  it("returns the launch id", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ launch: { id: "l1" } }));
    const out = await createLaunchPackage({ brief_id: "b1", pipeline_id: "p1" });
    expect(out.id).toBe("l1");
  });

  it("throws on non-2xx", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("bad", { status: 422 }));
    await expect(createLaunchPackage({ brief_id: "b1" })).rejects.toThrow(/422/);
  });

  it("falls back to statusText when body is empty", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("", { status: 500, statusText: "X" }));
    await expect(createLaunchPackage({ brief_id: "b1" })).rejects.toThrow(/X/);
  });
});

describe("cancelPipeline", () => {
  it("posts to /cancel and returns the pipeline", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ pipeline: { id: "p1", status: "cancelled" } }));
    const out = await cancelPipeline("p1");
    expect(out.pipeline.status).toBe("cancelled");
    expect((spy.mock.calls[0]?.[0] as string).endsWith("/p1/cancel")).toBe(true);
  });

  it("throws on non-2xx", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("", { status: 422 }));
    await expect(cancelPipeline("p1")).rejects.toThrow(/422/);
  });
});

describe("submitReviewDecision", () => {
  it("posts the decision body", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ pipeline: { id: "p1" } }));
    const out = await submitReviewDecision("p1", { decision: "approved" });
    expect(out.pipeline.id).toBe("p1");
    expect((spy.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe("POST");
  });

  it("throws on non-2xx", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("bad", { status: 422 }));
    await expect(submitReviewDecision("p1", { decision: "approved" })).rejects.toThrow(/422/);
  });

  it("falls back to statusText when body is empty", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("", { status: 500, statusText: "Bang" }));
    await expect(submitReviewDecision("p1", { decision: "approved" })).rejects.toThrow(/Bang/);
  });
});

describe("createLaunchPackage edge cases", () => {
  it("uses readJson — throws on malformed JSON", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(textResponse("not json"));
    await expect(createLaunchPackage({ brief_id: "b1" })).rejects.toThrow(/Invalid JSON/);
  });
});

describe("cancelPipeline edge cases", () => {
  it("falls back to statusText when body is empty", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("", { status: 500, statusText: "X" }));
    await expect(cancelPipeline("p1")).rejects.toThrow(/X/);
  });
});

describe("body-read catch fallbacks", () => {
  // Each error path uses `.text().catch(() => "")` so we cover those arrow
  // functions by returning a Response whose text() rejects.
  function failingResponse(status: number, statusText: string): Response {
    return {
      ok: false,
      status,
      statusText,
      headers: new Headers(),
      text: () => Promise.reject(new Error("body-fail")),
    } as unknown as Response;
  }

  it.each([
    ["createPipeline", async () => createPipeline({ format_choice: "image" })],
    ["listPipelines", async () => listPipelines()],
    ["getPipeline", async () => getPipeline("p1")],
    ["updatePicks", async () => updatePicks("p1", {})],
    ["createLaunchPackage", async () => createLaunchPackage({ brief_id: "b1" })],
    ["cancelPipeline", async () => cancelPipeline("p1")],
    ["submitReviewDecision", async () => submitReviewDecision("p1", { decision: "approved" })],
  ] as const)("%s falls back to statusText when body read fails", async (_name, run) => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(failingResponse(500, "Boom"));
    await expect(run()).rejects.toThrow(/Boom/);
  });
});

describe("resolveBaseUrl (browser branch)", () => {
  it("uses relative paths when running in the browser", async () => {
    // Pretend we're in a browser by defining `window` for the duration of
    // this test. Reset afterwards so other tests stay node-shaped.
    const had = "window" in globalThis;
    (globalThis as Record<string, unknown>).window = {};
    try {
      const spy = spyOnFetch();
      spy.mockResolvedValueOnce(jsonResponse({ pipeline: { id: "p1" } }));
      await createPipeline({ format_choice: "image" });
      // Relative URL — no host prefix.
      expect(spy.mock.calls[0]?.[0]).toBe("/api/pipelines");
    } finally {
      if (!had) {
        delete (globalThis as Record<string, unknown>).window;
      }
    }
  });
});
