/**
 * Test helpers for stubbing the worker / chat HTTP surface.
 *
 * Two patterns the codebase uses:
 *  - `fetch(...)` against `WORKER_URL` (via `lib/worker.ts`'s `callWorker`).
 *  - SSE streams from `/api/creatives/*\/chat` parsed by `lib/chat.ts`'s
 *    `readChatStream`.
 *
 * Tests don't want to spin up a real worker, so we expose
 *   - `stubFetchOnce(response)` to script one fetch call;
 *   - `stubFetchSequence(responses)` to script several in order;
 *   - `makeSseResponse(events)` to build a `Response` whose body emits SSE
 *     `data:` frames matching `StreamChunk`.
 */
import { vi, type MockInstance } from "vitest";

/**
 * Replace `globalThis.fetch` with a Vitest spy. Returns the spy so callers
 * can assert on `.mock.calls`.
 */
export function spyOnFetch(): MockInstance<typeof fetch> {
  const fetchSpy = vi.fn<typeof fetch>();
  // `vi.spyOn` requires the property to exist; `globalThis.fetch` is set in
  // both Node 18+ and jsdom environments so this is safe.
  return vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as unknown as typeof fetch);
}

/** Build a JSON `Response` with the given status. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/** Build a plain-text `Response`. */
export function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "text/plain",
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Build an SSE `Response` whose body emits each event as a `data: <json>\n\n`
 * frame. Pass plain objects — they're stringified for you.
 */
export function sseResponse(events: unknown[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    ...init,
    headers: {
      "content-type": "text/event-stream",
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Install a one-shot fetch stub. The spy resolves to `response` on the
 * first call and throws "unexpected extra fetch" thereafter. Useful for
 * route tests that only fire a single request.
 */
export function stubFetchOnce(response: Response): MockInstance<typeof fetch> {
  const spy = spyOnFetch();
  let used = false;
  spy.mockImplementation(async () => {
    if (used) throw new Error("unexpected extra fetch call");
    used = true;
    return response;
  });
  return spy;
}

/**
 * Install a fetch stub that returns the supplied responses in order, then
 * throws if more calls arrive than were scripted.
 */
export function stubFetchSequence(responses: Response[]): MockInstance<typeof fetch> {
  const spy = spyOnFetch();
  let i = 0;
  spy.mockImplementation(async () => {
    if (i >= responses.length) {
      throw new Error(`unexpected fetch call #${i + 1} (only ${responses.length} stubbed)`);
    }
    return responses[i++] as Response;
  });
  return spy;
}
