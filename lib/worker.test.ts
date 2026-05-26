import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `lib/worker.ts` imports `server-only` — neutralise it so the node test
// project can import the module under test.
vi.mock("server-only", () => ({}));

import { WorkerError, callWorker, qaRun, specRun, worker } from "./worker";
import { jsonResponse, spyOnFetch, textResponse } from "@/tests/unit/helpers/worker-mock";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env.WORKER_URL = "http://worker.test/api/";
  process.env.WORKER_SHARED_SECRET = "shh";
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  vi.restoreAllMocks();
});

describe("callWorker", () => {
  it("issues a Bearer-authenticated request and returns parsed JSON", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ ok: true, value: 1 }));

    const out = await callWorker<{ ok: boolean; value: number }>("/health");
    expect(out).toEqual({ ok: true, value: 1 });
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe("http://worker.test/api/health");
    const headers = (call?.[1] as RequestInit | undefined)?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer shh");
    expect(headers.get("Accept")).toBe("application/json");
  });

  it("returns text when content-type is not JSON", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(textResponse("ok-text"));
    const out = await callWorker<string>("/raw");
    expect(out).toBe("ok-text");
  });

  it("retries on 5xx and succeeds on the second try", async () => {
    const spy = spyOnFetch();
    spy
      .mockResolvedValueOnce(new Response("upstream timeout", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const out = await callWorker<{ ok: boolean }>("/health");
    expect(out).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("retries on transient throws (network error) and succeeds", async () => {
    const spy = spyOnFetch();
    let n = 0;
    spy.mockImplementation(async () => {
      n++;
      if (n === 1) throw new Error("ECONNRESET");
      return jsonResponse({ ok: true });
    });
    const out = await callWorker<{ ok: boolean }>("/h");
    expect(out).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it("throws WorkerError on a non-retriable 4xx", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("bad input body", { status: 400 }));
    await expect(callWorker("/h")).rejects.toThrow(WorkerError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("throws WorkerError when retries exhausted", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValue(new Response("still bad", { status: 500 }));
    await expect(callWorker("/h")).rejects.toThrow(WorkerError);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("wraps unknown errors after retry exhaustion", async () => {
    const spy = spyOnFetch();
    spy.mockImplementation(async () => {
      throw new Error("offline");
    });
    await expect(callWorker("/h")).rejects.toThrow(WorkerError);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("sends a JSON content-type when body is present and not already set", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await callWorker("/h", { method: "POST", body: JSON.stringify({ a: 1 }) });
    const headers = (spy.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("treats text body without content-type header as a JSON request", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await callWorker("/h", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "Content-Type": "application/json" },
    });
    const headers = (spy.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
  });
});

describe("worker.health", () => {
  it("hits /work/health", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ ok: true, service: "v1" }));
    const out = await worker.health();
    expect(out.ok).toBe(true);
    expect(spy.mock.calls[0]?.[0]).toBe("http://worker.test/api/work/health");
  });
});

describe("worker.qaRun", () => {
  it("POSTs the qa_run tool with the batch body and returns the result", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(
      jsonResponse({ ok: true, rollup: "passed", results: [], errors: [] }),
    );
    const out = await qaRun({
      pipeline_id: "p1",
      items: [{ creative_id: "c1", surface: "image" }],
    });
    expect(out.rollup).toBe("passed");
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe("http://worker.test/api/work/pipeline/tools/qa_run");
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      pipeline_id: "p1",
      items: [{ creative_id: "c1", surface: "image" }],
    });
  });

  it("is exposed on the worker namespace", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(
      jsonResponse({ ok: true, rollup: "passed", results: [], errors: [] }),
    );
    await worker.qaRun({ pipeline_id: "p1", items: [{ creative_id: "c1" }] });
    expect(spy.mock.calls[0]?.[0]).toBe("http://worker.test/api/work/pipeline/tools/qa_run");
  });
});

describe("worker.specRun", () => {
  it("POSTs the spec_result tool with the batch body", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const out = await specRun({
      pipeline_id: "p1",
      results: [{ creative_id: "c1", placement: "feed", status: "pass" }],
    });
    expect(out.ok).toBe(true);
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe("http://worker.test/api/work/pipeline/tools/spec_result");
    expect((call?.[1] as RequestInit).method).toBe("POST");
  });

  it("is exposed on the worker namespace", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await worker.specRun({
      pipeline_id: "p1",
      results: [{ creative_id: "c1", placement: "feed", status: "pass" }],
    });
    expect(spy.mock.calls[0]?.[0]).toBe("http://worker.test/api/work/pipeline/tools/spec_result");
  });
});

describe("callWorker transient retries", () => {
  it("retries on 429 then succeeds", async () => {
    const spy = spyOnFetch();
    spy
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const out = await callWorker<{ ok: boolean }>("/h");
    expect(out).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("retries on 408 then succeeds", async () => {
    const spy = spyOnFetch();
    spy
      .mockResolvedValueOnce(new Response("timeout", { status: 408 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const out = await callWorker<{ ok: boolean }>("/h");
    expect(out).toEqual({ ok: true });
  });

  it("prepends a slash when path doesn't start with /", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await callWorker("work/foo");
    expect(spy.mock.calls[0]?.[0]).toBe("http://worker.test/api/work/foo");
  });

  it("inlines the response text in the error message", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("oops body", { status: 400 }));
    await expect(callWorker("/h")).rejects.toThrow(/oops body/);
  });

  it("handles a body-read failure on the error path gracefully", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: vi.fn(() => Promise.reject(new Error("body-fail"))),
    } as unknown as Response);
    await expect(callWorker("/h")).rejects.toThrow(/Worker responded 400/);
  });
});
