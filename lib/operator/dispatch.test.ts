import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `lib/operator/dispatch.ts` imports `server-only`; neutralise it so the node
// test project can import the module under test.
vi.mock("server-only", () => ({}));

import { dispatchOperator, isOperatorDriven, operatorInstruction } from "./dispatch";
import { spyOnFetch } from "@/tests/unit/helpers/worker-mock";

const ORIG_ENV = { ...process.env };
const PIPELINE = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  process.env.WORKER_URL = "http://worker.test";
  process.env.WORKER_SHARED_SECRET = "shh";
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  vi.restoreAllMocks();
});

describe("operatorInstruction", () => {
  it("embeds the manager brief on the configuration kickoff", () => {
    const out = operatorInstruction("configuration", PIPELINE, "4 roofing ads, Austin");
    expect(out).toContain(PIPELINE);
    expect(out).toContain("4 roofing ads, Austin");
    expect(out.toLowerCase()).toContain("review");
  });

  it("falls back to a generic configuration ask without a brief", () => {
    const out = operatorInstruction("configuration", PIPELINE);
    expect(out).toContain(PIPELINE);
    expect(out.toLowerCase()).toContain("brief");
  });

  it("asks for concepts at ideation and finals at generation", () => {
    expect(operatorInstruction("ideation", PIPELINE).toLowerCase()).toContain("concept");
    expect(operatorInstruction("generation", PIPELINE).toLowerCase()).toContain("final");
  });

  it("tells the operator to stand by during review", () => {
    expect(operatorInstruction("review", PIPELINE).toLowerCase()).toContain("stand by");
  });
});

describe("isOperatorDriven", () => {
  it("is true when config_draft.operator_driven is true", () => {
    expect(isOperatorDriven({ operator_driven: true })).toBe(true);
  });

  it("is true when a non-empty operator_instruction is present (legacy rows)", () => {
    expect(isOperatorDriven({ operator_instruction: "4 roofing ads" })).toBe(true);
  });

  it("is false for a regular pipeline draft", () => {
    expect(isOperatorDriven({ image_payload: { market: "Austin" } })).toBe(false);
  });

  it("is false for empty / blank / non-object drafts", () => {
    expect(isOperatorDriven(null)).toBe(false);
    expect(isOperatorDriven(undefined)).toBe(false);
    expect(isOperatorDriven({})).toBe(false);
    expect(isOperatorDriven({ operator_instruction: "   " })).toBe(false);
    expect(isOperatorDriven([])).toBe(false);
    expect(isOperatorDriven("nope")).toBe(false);
  });
});

describe("dispatchOperator", () => {
  it("POSTs the instruction with bearer auth to the worker dispatch endpoint", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, dispatched: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await dispatchOperator(PIPELINE, "do the thing");

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("http://worker.test/work/pipeline/tools/dispatch");
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe("POST");
    expect((reqInit.headers as Record<string, string>).Authorization).toBe("Bearer shh");
    expect(JSON.parse(reqInit.body as string)).toEqual({
      pipeline_id: PIPELINE,
      instruction: "do the thing",
    });
  });

  it("trims a trailing slash on WORKER_URL", async () => {
    process.env.WORKER_URL = "http://worker.test/";
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await dispatchOperator(PIPELINE, "x");
    expect(spy.mock.calls[0]![0]).toBe("http://worker.test/work/pipeline/tools/dispatch");
  });

  it("no-ops (no fetch) when WORKER_URL is unset", async () => {
    delete process.env.WORKER_URL;
    const spy = spyOnFetch();
    await dispatchOperator(PIPELINE, "x");
    expect(spy).not.toHaveBeenCalled();
  });

  it("no-ops (no fetch) when WORKER_SHARED_SECRET is unset", async () => {
    delete process.env.WORKER_SHARED_SECRET;
    const spy = spyOnFetch();
    await dispatchOperator(PIPELINE, "x");
    expect(spy).not.toHaveBeenCalled();
  });

  it("swallows a 404 (endpoint not deployed yet)", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(dispatchOperator(PIPELINE, "x")).resolves.toBeUndefined();
  });

  it("throws on any other non-2xx so the caller can log it", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(dispatchOperator(PIPELINE, "x")).rejects.toThrow(/500/);
  });
});
