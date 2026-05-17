import { z } from "zod";

/**
 * Chat-with-Ekko shared types + lightweight wire helpers.
 *
 * The chat surface is symmetric across image and video creatives — the
 * SidePanel and VideoSidePanel both render `<EkkoChat />`, which speaks
 * the schemas below. The transport is SSE; this module owns the
 * client-side parser plus the request schema.
 *
 * The server-side SSE wire format (mirrored on the worker in
 * ``worker/src/routes/chat_stream.py``):
 *
 *   data: {"type": "text_delta", "delta": "..."}\n\n
 *   data: {"type": "tool_call_start", "tool": "...", "input": {...}}\n\n
 *   data: {"type": "tool_call_result", "tool": "...", "result": {...}}\n\n
 *   data: {"type": "message_stop"}\n\n
 *   data: {"type": "error", "message": "..."}\n\n
 *
 * `: keepalive` comment lines may appear between events; the parser
 * silently drops them.
 */

// ---------------------------------------------------------------------------
// Message shape (request side)
// ---------------------------------------------------------------------------

export const ChatRole = z.enum(["user", "assistant"]);
export type ChatRoleT = z.infer<typeof ChatRole>;

export const ChatMessage = z.object({
  role: ChatRole,
  content: z.string().min(1),
});
export type ChatMessageT = z.infer<typeof ChatMessage>;

/**
 * Tool schema exposed in the chat. Mirrors the Anthropic SDK shape so
 * the worker can forward it untouched. `input_schema` is a JSON schema
 * describing the tool's inputs.
 */
export const ToolSpec = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  input_schema: z.record(z.string(), z.unknown()).optional().default({}),
});
export type ToolSpecT = z.infer<typeof ToolSpec>;

/**
 * Body of `POST /api/creatives/:id/chat` and
 * `POST /api/creatives/video/:id/chat`. The server fills in
 * `creative_id` from the URL — clients only send messages + optional
 * tools + system prompt overrides.
 */
export const ChatRequest = z.object({
  messages: z.array(ChatMessage).min(1, "messages must not be empty"),
  tools: z.array(ToolSpec).optional(),
  system_prompt: z.string().optional(),
});
export type ChatRequestT = z.infer<typeof ChatRequest>;

// ---------------------------------------------------------------------------
// Stream chunk (response side)
// ---------------------------------------------------------------------------

/**
 * Tagged union of every event the SSE stream can emit. Keep this in
 * lock-step with `worker.src.services.claude_runner.StreamChunk`.
 */
export type StreamChunk =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; tool: string; input?: unknown }
  | { type: "tool_call_result"; tool: string; result?: unknown }
  | { type: "message_stop" }
  | { type: "error"; message: string };

/**
 * Parse one JSON object that came in on an SSE `data:` line. Returns
 * `null` for malformed shapes so the consumer can ignore + continue
 * (the connection is more valuable than any individual frame).
 */
export function parseStreamChunk(raw: string): StreamChunk | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const t = (obj as { type?: unknown }).type;
  if (typeof t !== "string") return null;
  switch (t) {
    case "text_delta": {
      const delta = (obj as { delta?: unknown }).delta;
      if (typeof delta !== "string") return null;
      return { type: "text_delta", delta };
    }
    case "tool_call_start": {
      const tool = (obj as { tool?: unknown }).tool;
      if (typeof tool !== "string") return null;
      return { type: "tool_call_start", tool, input: (obj as { input?: unknown }).input };
    }
    case "tool_call_result": {
      const tool = (obj as { tool?: unknown }).tool;
      if (typeof tool !== "string") return null;
      return { type: "tool_call_result", tool, result: (obj as { result?: unknown }).result };
    }
    case "message_stop":
      return { type: "message_stop" };
    case "error": {
      const message = (obj as { message?: unknown }).message;
      return {
        type: "error",
        message: typeof message === "string" ? message : "unknown error",
      };
    }
    default:
      return null;
  }
}

/**
 * Iterate over an SSE ReadableStream from a `fetch` response and yield
 * structured `StreamChunk`s. Skips heartbeat comments + malformed
 * frames silently.
 *
 * Caller is responsible for cleanup; use an `AbortController` to cancel
 * mid-stream.
 *
 * Implementation note: SSE messages are delimited by a blank line, and
 * each message may contain multiple `data:` fields (concatenated with
 * `\n`). We hold a small buffer and flush whenever a `\n\n` boundary
 * appears.
 */
export async function* readChatStream(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk, void, unknown> {
  if (!response.body) {
    yield {
      type: "error",
      message: "chat response has no body — worker may be offline",
    };
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events terminated by a blank line. The
      // standard says `\n\n` but we tolerate `\r\n\r\n` too.
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const eventText = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");

        // SSE allows multiple `data:` lines per event; concatenate.
        const dataLines: string[] = [];
        for (const line of eventText.split(/\r?\n/)) {
          if (line.startsWith(":")) continue; // comment / heartbeat
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }
        if (dataLines.length === 0) continue;
        const chunk = parseStreamChunk(dataLines.join("\n"));
        if (chunk) yield chunk;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Display models (used by EkkoChat to render messages + tool calls)
// ---------------------------------------------------------------------------

export type ToolCallView = {
  id: string;
  tool: string;
  input: unknown;
  result: unknown | null;
  /** Whether the tool call is still in flight. */
  pending: boolean;
};

export type DisplayMessage =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      text: string;
      /** Tool calls captured during this assistant turn. */
      toolCalls: ToolCallView[];
      /** Streaming flag — true while deltas are still arriving. */
      streaming: boolean;
    };

/** Build a stable id for a new message — `crypto.randomUUID` when available. */
export function newMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `m-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
}
