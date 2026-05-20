/**
 * Tests for the server-side Realtime SSE relay route. We mock the admin
 * Supabase client's channel so we can drive `postgres_changes` callbacks and
 * the subscribe-status callback, then read the SSE body off the stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeSubs } from "@/lib/realtime/topics";

type ChangeHandler = (payload: { eventType: string; new?: unknown; old?: unknown }) => void;

type FakeChannel = {
  name: string;
  // Registered postgres_changes handlers, keyed by table.
  handlers: Array<{ table: string; event: string; cb: ChangeHandler }>;
  on: (type: string, spec: { event: string; table: string }, cb: ChangeHandler) => FakeChannel;
  subscribe: (cb: (status: string) => void) => FakeChannel;
  _statusCb: ((status: string) => void) | null;
};

const channels: FakeChannel[] = [];
const removeChannel = vi.fn(async () => undefined);

function makeChannel(name: string): FakeChannel {
  const ch: FakeChannel = {
    name,
    handlers: [],
    _statusCb: null,
    on(_type, spec, cb) {
      this.handlers.push({ table: spec.table, event: spec.event, cb });
      return this;
    },
    subscribe(cb) {
      this._statusCb = cb;
      return this;
    },
  };
  channels.push(ch);
  return ch;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    channel: (name: string) => makeChannel(name),
    removeChannel,
  }),
}));

import { GET } from "./route";

/** Read the readable stream as text until `close()` is called by the route. */
async function drain(res: Response, signalToWatch?: AbortController): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  // Read a bounded number of chunks so a still-open stream doesn't hang the test.
  for (let i = 0; i < 50; i += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
    if (signalToWatch && signalToWatch.signal.aborted) {
      // Allow one more flush then stop.
    }
  }
  return out;
}

function makeReq(subs: string | null, signal?: AbortSignal): Request {
  const url = subs === null ? "http://x/api/realtime" : `http://x/api/realtime?subs=${subs}`;
  return new Request(url, signal ? { signal } : undefined);
}

beforeEach(() => {
  channels.length = 0;
  removeChannel.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET /api/realtime", () => {
  it("400s when subs is missing", async () => {
    const res = await GET(makeReq(null) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
  });

  it("400s when subs decodes to an empty/invalid spec list", async () => {
    const res = await GET(makeReq("not-valid-base64!!!") as never);
    expect(res.status).toBe(400);
  });

  it("subscribes the requested specs and streams change events as SSE", async () => {
    const subs = encodeSubs([
      { table: "approvals", event: "INSERT" },
      { table: "pipeline_events", event: "*", filter: "pipeline_id=eq.p1" },
    ]);
    const ac = new AbortController();
    const res = await GET(makeReq(subs, ac.signal) as never);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // One channel opened with both specs registered.
    expect(channels).toHaveLength(1);
    const ch = channels[0]!;
    expect(ch.handlers.map((h) => `${h.table}:${h.event}`)).toEqual([
      "approvals:INSERT",
      "pipeline_events:*",
    ]);

    // Drive a subscribe -> SUBSCRIBED (emits a `ready` event) then a change.
    ch._statusCb?.("SUBSCRIBED");
    ch.handlers[0]!.cb({ eventType: "INSERT", new: { id: "a1" }, old: {} });

    // Close the stream so drain() terminates.
    ac.abort();
    const body = await drain(res);
    expect(body).toContain(": connected");
    expect(body).toContain("event: ready");
    expect(body).toContain('"table":"approvals"');
    expect(body).toContain('"eventType":"INSERT"');
    expect(body).toContain('"id":"a1"');
  });

  it("emits an error event on a terminal channel status", async () => {
    const subs = encodeSubs([{ table: "briefs", event: "UPDATE", filter: "id=eq.b1" }]);
    const ac = new AbortController();
    const res = await GET(makeReq(subs, ac.signal) as never);
    const ch = channels[0]!;
    ch._statusCb?.("CHANNEL_ERROR");
    ac.abort();
    const body = await drain(res);
    expect(body).toContain("event: error");
    expect(body).toContain("CHANNEL_ERROR");
  });

  it("emits a heartbeat comment on the interval", async () => {
    const subs = encodeSubs([{ table: "briefs", event: "*" }]);
    const ac = new AbortController();
    const res = await GET(makeReq(subs, ac.signal) as never);
    // Advance past the 25s heartbeat.
    vi.advanceTimersByTime(26_000);
    ac.abort();
    const body = await drain(res);
    expect(body).toContain(": ping");
  });

  it("removes the Supabase channel when the client disconnects (abort)", async () => {
    const subs = encodeSubs([{ table: "briefs", event: "*" }]);
    const ac = new AbortController();
    const res = await GET(makeReq(subs, ac.signal) as never);
    expect(channels).toHaveLength(1);
    ac.abort();
    await drain(res);
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });

  it("cleans up via the stream cancel() path when the reader is cancelled", async () => {
    const subs = encodeSubs([{ table: "briefs", event: "*" }]);
    const res = await GET(makeReq(subs) as never);
    expect(channels).toHaveLength(1);
    // Cancelling the reader invokes ReadableStream.cancel() — the relay's
    // secondary teardown (clears heartbeat + removes the channel).
    const reader = res.body!.getReader();
    await reader.read(); // pull the initial ": connected" chunk
    await reader.cancel();
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });
});
