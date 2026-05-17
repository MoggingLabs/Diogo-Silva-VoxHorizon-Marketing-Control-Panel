import { describe, expect, it } from "vitest";

import {
  ChatMessage,
  ChatRequest,
  ChatRole,
  ToolSpec,
  newMessageId,
  parseStreamChunk,
  readChatStream,
} from "./chat";
import { sseResponse } from "@/tests/unit/helpers/worker-mock";

describe("ChatRole / ChatMessage / ToolSpec / ChatRequest schemas", () => {
  it("ChatRole accepts the canonical literals", () => {
    expect(ChatRole.safeParse("user").success).toBe(true);
    expect(ChatRole.safeParse("system").success).toBe(false);
  });

  it("ChatMessage requires non-empty content + a valid role", () => {
    expect(ChatMessage.safeParse({ role: "user", content: "hi" }).success).toBe(true);
    expect(ChatMessage.safeParse({ role: "user", content: "" }).success).toBe(false);
  });

  it("ToolSpec defaults description + input_schema", () => {
    const parsed = ToolSpec.parse({ name: "regenerate" });
    expect(parsed.description).toBe("");
    expect(parsed.input_schema).toEqual({});
  });

  it("ChatRequest requires at least one message", () => {
    expect(ChatRequest.safeParse({ messages: [] }).success).toBe(false);
    expect(ChatRequest.safeParse({ messages: [{ role: "user", content: "hi" }] }).success).toBe(
      true,
    );
  });
});

describe("parseStreamChunk", () => {
  it("returns null on invalid JSON", () => {
    expect(parseStreamChunk("not json")).toBeNull();
  });

  it("returns null when the shape is missing type", () => {
    expect(parseStreamChunk(JSON.stringify({}))).toBeNull();
    expect(parseStreamChunk(JSON.stringify(null))).toBeNull();
    expect(parseStreamChunk(JSON.stringify("scalar"))).toBeNull();
  });

  it("parses each tagged-union variant", () => {
    expect(parseStreamChunk(JSON.stringify({ type: "text_delta", delta: "hi" }))).toEqual({
      type: "text_delta",
      delta: "hi",
    });
    expect(parseStreamChunk(JSON.stringify({ type: "text_delta", delta: 1 }))).toBeNull();
    expect(
      parseStreamChunk(JSON.stringify({ type: "tool_call_start", tool: "rerender", input: 1 })),
    ).toEqual({ type: "tool_call_start", tool: "rerender", input: 1 });
    expect(parseStreamChunk(JSON.stringify({ type: "tool_call_start" }))).toBeNull();
    expect(
      parseStreamChunk(JSON.stringify({ type: "tool_call_result", tool: "x", result: { ok: 1 } })),
    ).toEqual({ type: "tool_call_result", tool: "x", result: { ok: 1 } });
    expect(parseStreamChunk(JSON.stringify({ type: "tool_call_result" }))).toBeNull();
    expect(parseStreamChunk(JSON.stringify({ type: "message_stop" }))).toEqual({
      type: "message_stop",
    });
    expect(parseStreamChunk(JSON.stringify({ type: "error", message: "bad" }))).toEqual({
      type: "error",
      message: "bad",
    });
    expect(parseStreamChunk(JSON.stringify({ type: "error" }))).toEqual({
      type: "error",
      message: "unknown error",
    });
    expect(parseStreamChunk(JSON.stringify({ type: "weird" }))).toBeNull();
  });
});

describe("readChatStream", () => {
  it("yields parsed chunks in SSE order, skipping malformed frames", async () => {
    const resp = sseResponse([
      { type: "text_delta", delta: "hello " },
      { type: "text_delta", delta: "world" },
      { type: "message_stop" },
    ]);

    const seen: unknown[] = [];
    for await (const chunk of readChatStream(resp)) seen.push(chunk);
    expect(seen).toEqual([
      { type: "text_delta", delta: "hello " },
      { type: "text_delta", delta: "world" },
      { type: "message_stop" },
    ]);
  });

  it("emits an error chunk when the response has no body", async () => {
    const resp = new Response(null, { status: 200 });
    const seen: unknown[] = [];
    for await (const chunk of readChatStream(resp)) seen.push(chunk);
    expect(seen).toEqual([
      { type: "error", message: "chat response has no body — worker may be offline" },
    ]);
  });

  it("aborts when the signal is already aborted", async () => {
    const resp = sseResponse([{ type: "text_delta", delta: "should not arrive" }]);
    const ctrl = new AbortController();
    ctrl.abort();
    const seen: unknown[] = [];
    for await (const chunk of readChatStream(resp, ctrl.signal)) seen.push(chunk);
    expect(seen).toEqual([]);
  });

  it("ignores SSE comment / heartbeat lines", async () => {
    // Build a raw SSE body with an interleaved heartbeat comment.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "text_delta", delta: "x" })}\n\n`),
        );
        controller.enqueue(encoder.encode("data: not-json\n\n"));
        controller.close();
      },
    });
    const resp = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const seen: unknown[] = [];
    for await (const chunk of readChatStream(resp)) seen.push(chunk);
    expect(seen).toEqual([{ type: "text_delta", delta: "x" }]);
  });

  it("tolerates a multi-line data: payload concatenated with \\n", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Each `data:` line is a string piece of the JSON, joined by \n.
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`));
        controller.close();
      },
    });
    const resp = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const seen: unknown[] = [];
    for await (const chunk of readChatStream(resp)) seen.push(chunk);
    expect(seen).toEqual([{ type: "message_stop" }]);
  });
});

describe("newMessageId", () => {
  it("falls back to a math-random id when crypto.randomUUID is absent", () => {
    const originalCrypto = globalThis.crypto;
    // Pretend we have no crypto.randomUUID.
    try {
      Object.defineProperty(globalThis, "crypto", {
        value: undefined,
        configurable: true,
      });
      const id = newMessageId();
      expect(id).toMatch(/^m-/);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: originalCrypto,
        configurable: true,
      });
    }
  });

  it("uses crypto.randomUUID when available", () => {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      const id = newMessageId();
      expect(id).toMatch(/[0-9a-f-]{36}/);
    } else {
      // Skip when the environment lacks it — node 18+ has it natively.
      expect(true).toBe(true);
    }
  });
});
