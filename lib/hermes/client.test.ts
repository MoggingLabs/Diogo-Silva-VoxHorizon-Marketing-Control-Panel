import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `lib/hermes/client.ts` imports `server-only` — neutralise it so the
// node test project can import the module under test.
vi.mock("server-only", () => ({}));

import {
  chatAbort,
  chatStream,
  hermes,
  HermesError,
  kanbanCancel,
  kanbanCreate,
  kanbanEvents,
  kanbanGet,
  kanbanRetry,
} from "./client";
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

// ---------------------------------------------------------------------------
// callHermes (exercised through the typed entry points)
// ---------------------------------------------------------------------------

describe("hermes typed RPC surface", () => {
  it("kanbanCreate issues a Bearer-authenticated POST", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(
      jsonResponse({ task_id: "t1", assignee: "ekko", board: "voxhorizon" }),
    );
    const out = await kanbanCreate({ title: "Do thing" });
    expect(out.task_id).toBe("t1");
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe("http://worker.test/api/work/hermes/kanban");
    const init = call?.[1] as RequestInit | undefined;
    const headers = init?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer shh");
    expect(init?.method).toBe("POST");
    expect(typeof init?.body).toBe("string");
  });

  it("kanbanGet calls GET /work/hermes/kanban/{id}", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(
      jsonResponse({
        id: "t1",
        status: "pending",
        assignee: "ekko",
        title: "Do",
        board: "voxhorizon",
        context: {},
        result: null,
        comments: [],
        events: [],
        parent_id: null,
      }),
    );
    const out = await kanbanGet("t1");
    expect(out.status).toBe("pending");
    expect(spy.mock.calls[0]?.[0]).toBe("http://worker.test/api/work/hermes/kanban/t1");
  });

  it("kanbanCancel POSTs cancel", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ task_id: "t1", action: "cancel", ok: true }));
    const out = await kanbanCancel("t1");
    expect(out.action).toBe("cancel");
    expect(spy.mock.calls[0]?.[0]).toBe("http://worker.test/api/work/hermes/kanban/t1/cancel");
  });

  it("kanbanRetry POSTs retry", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ task_id: "t1", action: "retry", ok: true }));
    const out = await kanbanRetry("t1");
    expect(out.action).toBe("retry");
    expect(spy.mock.calls[0]?.[0]).toBe("http://worker.test/api/work/hermes/kanban/t1/retry");
  });

  it("chatAbort POSTs the session_id", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ aborted: true }));
    const out = await chatAbort({ session_id: "s1" });
    expect(out.aborted).toBe(true);
    expect(spy.mock.calls[0]?.[0]).toBe("http://worker.test/api/work/hermes/chat/abort");
  });

  it("kanbanGet url-encodes the task id", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(
      jsonResponse({
        id: "weird id",
        status: "pending",
        assignee: "ekko",
        title: "",
        board: "voxhorizon",
        context: {},
        result: null,
        comments: [],
        events: [],
        parent_id: null,
      }),
    );
    await kanbanGet("weird id");
    expect(spy.mock.calls[0]?.[0]).toBe("http://worker.test/api/work/hermes/kanban/weird%20id");
  });

  it("returns text when content-type is not JSON", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(textResponse("hello"));
    // Hit any json endpoint — content-type override drives the branch.
    const out = await chatAbort({ session_id: "s1" });
    expect(out as unknown as string).toBe("hello");
    expect(spy).toHaveBeenCalled();
  });

  it("retries on 5xx and succeeds on retry", async () => {
    const spy = spyOnFetch();
    spy
      .mockResolvedValueOnce(new Response("err", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ task_id: "t1", action: "retry", ok: true }));
    const out = await kanbanRetry("t1");
    expect(out.action).toBe("retry");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("retries on transient throw (network) and succeeds", async () => {
    const spy = spyOnFetch();
    let n = 0;
    spy.mockImplementation(async () => {
      n++;
      if (n === 1) throw new Error("ECONNRESET");
      return jsonResponse({ task_id: "t1", action: "retry", ok: true });
    });
    const out = await kanbanRetry("t1");
    expect(out.action).toBe("retry");
    expect(n).toBe(2);
  });

  it("retries on 408 then succeeds", async () => {
    const spy = spyOnFetch();
    spy
      .mockResolvedValueOnce(new Response("timeout", { status: 408 }))
      .mockResolvedValueOnce(jsonResponse({ task_id: "t1", action: "retry", ok: true }));
    const out = await kanbanRetry("t1");
    expect(out.action).toBe("retry");
  });

  it("retries on 429 then succeeds", async () => {
    const spy = spyOnFetch();
    spy
      .mockResolvedValueOnce(new Response("too many", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ task_id: "t1", action: "retry", ok: true }));
    const out = await kanbanRetry("t1");
    expect(out.action).toBe("retry");
  });

  it("throws HermesError on non-retriable 4xx without retry", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("bad", { status: 400 }));
    await expect(kanbanCancel("t1")).rejects.toThrow(HermesError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("throws HermesError after retry exhaustion", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValue(new Response("still bad", { status: 500 }));
    await expect(kanbanCancel("t1")).rejects.toThrow(HermesError);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("wraps unknown thrown errors after retry exhaustion", async () => {
    const spy = spyOnFetch();
    spy.mockImplementation(async () => {
      throw new Error("offline");
    });
    await expect(kanbanCancel("t1")).rejects.toThrow(HermesError);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("inlines the response text in the error message", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("oops body", { status: 400 }));
    await expect(kanbanCancel("t1")).rejects.toThrow(/oops body/);
  });

  it("handles a body-read failure on the error path gracefully", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: vi.fn(() => Promise.reject(new Error("body-fail"))),
    } as unknown as Response);
    await expect(kanbanCancel("t1")).rejects.toThrow(/Hermes responded 400/);
  });

  it("HermesError preserves the status code", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    await expect(kanbanCancel("t1")).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// Streaming entry points — caller owns body, we just confirm the fetch shape.
// ---------------------------------------------------------------------------

describe("hermes streaming surface", () => {
  it("chatStream issues a Bearer-authed POST with text/event-stream accept", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const out = await chatStream({ messages: [{ role: "user", content: "hi" }] });
    expect(out.status).toBe(200);
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer shh");
    expect(headers.Accept).toBe("text/event-stream");
    expect(init?.method).toBe("POST");
  });

  it("chatStream forwards the AbortSignal", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("ok"));
    const controller = new AbortController();
    await chatStream({ messages: [{ role: "user", content: "hi" }] }, controller.signal);
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBe(controller.signal);
  });

  it("kanbanEvents issues a GET with text/event-stream accept", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("ok"));
    const out = await kanbanEvents("t1");
    expect(out.status).toBe(200);
    const url = spy.mock.calls[0]?.[0];
    expect(url).toBe("http://worker.test/api/work/hermes/kanban/t1/events");
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("GET");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Accept).toBe("text/event-stream");
  });

  it("kanbanEvents url-encodes the task id", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(new Response("ok"));
    await kanbanEvents("with space");
    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://worker.test/api/work/hermes/kanban/with%20space/events",
    );
  });
});

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

describe("hermes namespace", () => {
  it("re-exports the typed entry points", () => {
    expect(hermes.chatStream).toBe(chatStream);
    expect(hermes.chatAbort).toBe(chatAbort);
    expect(hermes.kanbanCreate).toBe(kanbanCreate);
    expect(hermes.kanbanGet).toBe(kanbanGet);
    expect(hermes.kanbanCancel).toBe(kanbanCancel);
    expect(hermes.kanbanRetry).toBe(kanbanRetry);
    expect(hermes.kanbanEvents).toBe(kanbanEvents);
  });
});
