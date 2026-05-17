"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Send, StopCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  newMessageId,
  readChatStream,
  type ChatMessageT,
  type DisplayMessage,
  type StreamChunk,
  type ToolCallView,
} from "@/lib/chat";
import { groupMessages, type GroupingItem } from "@/lib/chat-grouping";

import { ToolCallCard } from "./ToolCallCard";

/**
 * Format-agnostic chat surface for the Side Panel.
 *
 * Wave 6 polish:
 *  - **Optimistic temp-ID swap** (#144): user messages and assistant
 *    placeholders get a `temp-` id immediately on submit. The
 *    placeholder text streams in via the SSE channel; if the request
 *    errors out we replace the assistant bubble with an inline error
 *    + a Retry affordance and keep the user's text.
 *  - **RAF-batched stream rendering** (#145): incoming text deltas go
 *    into a ref + `requestAnimationFrame` tick, so high-frequency
 *    chunks only trigger one React render per ~16ms instead of one
 *    per token. Tool-call start/result events still flush immediately
 *    because they're sparse and the visual state change is meaningful.
 *  - **Grouping by sender + 5-min window + date separators** (#146):
 *    the rendered list is produced by `lib/chat-grouping.groupMessages`.
 *    Same-sender messages within 5 minutes lose their author label
 *    after the first, and a date separator gets inserted on calendar-
 *    day boundaries.
 *  - **Stop button + abort endpoint** (#147): the existing local
 *    `AbortController.abort()` is kept (it stops the local fetch); we
 *    ALSO POST to `/api/.../chat/abort` so the upstream worker breaks
 *    out of its tool-call wait.
 *
 * Props:
 *  - `endpoint`: the chat API URL — usually `/api/creatives/[id]/chat`
 *    or `/api/creatives/video/[id]/chat`. Already authorised on the
 *    server.
 *  - `abortEndpoint`: optional override for the abort URL. Defaults to
 *    `${endpoint}/abort` which matches the two server-side routes.
 *  - `creativeId`: ID of the creative this chat belongs to. Used in
 *    the placeholder text + as a localStorage key for read-status.
 *  - `creativeKind`: "image" or "video"; tweaks tone-of-voice.
 *  - `onIterate`: callback fired when an assistant turn finishes
 *    AND included at least one `tool_call_result`. The parent uses
 *    this to refresh the iteration thread / preview pane.
 */
export type EkkoChatProps = {
  endpoint: string;
  abortEndpoint?: string;
  creativeId: string;
  creativeKind: "image" | "video";
  onIterate?: () => void;
  /** Optional class for the outer container, for parent layout tweaks. */
  className?: string;
};

const TEMP_USER_PREFIX = "temp-user-";
const TEMP_ASSISTANT_PREFIX = "temp-assistant-";

function newTempId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
}

function isTempId(id: string): boolean {
  return id.startsWith(TEMP_USER_PREFIX) || id.startsWith(TEMP_ASSISTANT_PREFIX);
}

export function EkkoChat({
  endpoint,
  abortEndpoint,
  creativeId,
  creativeKind,
  onIterate,
  className,
}: EkkoChatProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each display message gets a stamped timestamp so the grouping util
  // has something stable to work with. Keyed by message id.
  const [timestamps, setTimestamps] = useState<Record<string, string>>({});

  // RAF batching state for text deltas.
  const textBufRef = useRef<Map<string, string>>(new Map());
  const rafIdRef = useRef<number | null>(null);
  const pendingRafRef = useRef(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inflightAssistantIdRef = useRef<string | null>(null);

  // Auto-scroll to the bottom whenever messages change.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Reset when the creative changes — different chat history per id.
  useEffect(() => {
    setMessages([]);
    setTimestamps({});
    setInput("");
    setError(null);
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    textBufRef.current.clear();
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    pendingRafRef.current = false;
    inflightAssistantIdRef.current = null;
  }, [creativeId]);

  // Cancel any inflight stream on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  // Schedule a RAF flush of any buffered text deltas. The buffer is
  // keyed by assistant message id so simultaneous (or rapid-resume)
  // streams don't trample each other.
  const scheduleFlush = useCallback(() => {
    if (pendingRafRef.current) return;
    pendingRafRef.current = true;
    rafIdRef.current = requestAnimationFrame(() => {
      pendingRafRef.current = false;
      rafIdRef.current = null;
      const buf = textBufRef.current;
      if (buf.size === 0) return;
      // Snapshot the current state but DO NOT clear the buffer — the
      // accumulator must survive across flushes so subsequent deltas
      // append rather than restart from "". The buffer is reset for
      // the next assistant turn in `submit` and cleaned up in the
      // finally block when the stream finishes.
      const snapshot = new Map(buf);
      setMessages((prev) =>
        prev.map((m) => {
          if (m.kind !== "assistant") return m;
          const fullText = snapshot.get(m.id);
          if (fullText === undefined) return m;
          // The buffer always holds the FULL accumulated text for
          // this assistant turn (we append on each delta), so a single
          // assign is correct.
          return { ...m, text: fullText };
        }),
      );
    });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    // Fire the worker-side abort POST best-effort — local cancel is
    // already done; this kicks the upstream out of a tool wait.
    const url = abortEndpoint ?? `${endpoint}/abort`;
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      keepalive: true,
    }).catch(() => {
      /* best effort — local abort already happened */
    });
  }, [abortEndpoint, endpoint]);

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;
      setError(null);

      const userTempId = newTempId(TEMP_USER_PREFIX);
      const assistantTempId = newTempId(TEMP_ASSISTANT_PREFIX);
      const userMsg: DisplayMessage = {
        kind: "user",
        id: userTempId,
        text: trimmed,
      };
      const assistantMsg: DisplayMessage = {
        kind: "assistant",
        id: assistantTempId,
        text: "",
        toolCalls: [],
        streaming: true,
      };
      inflightAssistantIdRef.current = assistantTempId;

      const nowIso = new Date().toISOString();
      // Build the wire-format history from the current view + the new
      // user message. Assistant placeholder is omitted (no content yet).
      const wireHistory: ChatMessageT[] = [
        ...messages.map<ChatMessageT>((m) => ({
          role: (m.kind === "user" ? "user" : "assistant") as ChatMessageT["role"],
          content: m.text,
        })),
        { role: "user" as const, content: trimmed },
      ].filter((m) => m.content.length > 0);

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setTimestamps((prev) => ({ ...prev, [userTempId]: nowIso, [assistantTempId]: nowIso }));
      setInput("");
      setStreaming(true);

      // Reset the buffer entry for this assistant turn.
      textBufRef.current.set(assistantTempId, "");

      const controller = new AbortController();
      abortRef.current = controller;
      let sawTool = false;

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: wireHistory }),
          signal: controller.signal,
        });

        if (!response.ok) {
          let payload: { error?: string } | null = null;
          try {
            payload = await response.json();
          } catch {
            /* ignore */
          }
          throw new Error(payload?.error ?? `chat failed: HTTP ${response.status}`);
        }

        for await (const chunk of readChatStream(response, controller.signal)) {
          // Detect tool activity at the chunk-handler level rather than
          // inside the setMessages reducer — React defers reducer
          // execution to commit time, so the inside-reducer mutation
          // races against the `finally` block that fires `onIterate`.
          if (chunk.type === "tool_call_start" || chunk.type === "tool_call_result") {
            sawTool = true;
          }
          applyChunk(
            setMessages,
            assistantTempId,
            chunk,
            () => {
              sawTool = true;
            },
            textBufRef,
            scheduleFlush,
          );
          if (chunk.type === "error") {
            setError(chunk.message);
            break;
          }
          if (chunk.type === "message_stop") {
            break;
          }
        }
      } catch (e) {
        if ((e as { name?: string }).name !== "AbortError") {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        // Final flush so the last delta lands before we drop the
        // streaming flag. Then mark the assistant message done.
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        pendingRafRef.current = false;
        const buf = textBufRef.current;
        const finalText = buf.get(assistantTempId);
        if (finalText !== undefined) buf.delete(assistantTempId);

        setMessages((prev) =>
          prev.map((m) => {
            if (m.kind !== "assistant" || m.id !== assistantTempId) return m;
            return {
              ...m,
              text: finalText ?? m.text,
              streaming: false,
              toolCalls: m.toolCalls.map((c) => ({ ...c, pending: false })),
            };
          }),
        );
        setStreaming(false);
        abortRef.current = null;
        inflightAssistantIdRef.current = null;
        if (sawTool) onIterate?.();
      }
    },
    [endpoint, messages, onIterate, scheduleFlush, streaming],
  );

  // Allow the parent to retry the last user message after an error.
  // Implementation note: we look at the last "user" message regardless
  // of streaming state — pressing Retry while a stream is running
  // would be confusing, so we gate it on `!streaming` in the UI.
  const retry = useCallback(() => {
    const lastUser = [...messages].reverse().find((m) => m.kind === "user");
    if (!lastUser) return;
    // Drop the last assistant placeholder (which carried the failed
    // turn) so the retried submission produces a fresh one.
    setMessages((prev) => {
      const lastAssistantIdx = [...prev]
        .reverse()
        .findIndex((m) => m.kind === "assistant" && !m.streaming);
      if (lastAssistantIdx === -1) return prev;
      const realIdx = prev.length - 1 - lastAssistantIdx;
      return prev.slice(0, realIdx);
    });
    void submit(lastUser.text);
  }, [messages, submit]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Plain Enter sends; Shift+Enter inserts a newline.
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        void submit(input);
      }
    },
    [input, submit],
  );

  const placeholder =
    creativeKind === "image"
      ? "Ask Ekko to tweak the image, change copy, or composite an overlay…"
      : "Ask Ekko to swap a clip, redo the voiceover, or re-render the video…";

  // Build the grouped render list. Messages without an explicit
  // timestamp default to "now" — the first paint of an SSR-fetched
  // history can provide real timestamps via `timestamps` state.
  const grouped: GroupingItem<{
    id: string;
    createdAt: string;
    senderKey: string;
    msg: DisplayMessage;
  }>[] = useMemo(() => {
    if (messages.length === 0) return [];
    const augmented = messages.map((m) => ({
      id: m.id,
      createdAt: timestamps[m.id] ?? new Date().toISOString(),
      senderKey: m.kind,
      msg: m,
    }));
    return groupMessages(augmented);
  }, [messages, timestamps]);

  return (
    <div className={cn("flex h-full flex-col gap-2", className)}>
      <div
        ref={scrollRef}
        data-thread-searchable=""
        className="max-h-[480px] min-h-[120px] flex-1 overflow-y-auto rounded-md border bg-card p-2"
        aria-live="polite"
      >
        {grouped.length === 0 ? (
          <p className="px-1 py-3 text-center text-xs text-muted-foreground">
            Start a conversation with Ekko about this creative.
          </p>
        ) : (
          <ol className="space-y-1">
            {grouped.map((item) =>
              item.type === "date-separator" ? (
                <li key={item.key} className="my-1.5 flex items-center gap-2 px-1">
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {item.label}
                  </span>
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                </li>
              ) : (
                <li
                  key={item.message.id}
                  className={cn("flex gap-2", item.isLastInGroup ? "pb-1" : "pb-0.5")}
                >
                  {item.message.msg.kind === "user" ? (
                    <UserBubble
                      text={item.message.msg.text}
                      isFirstInGroup={item.isFirstInGroup}
                      isLastInGroup={item.isLastInGroup}
                    />
                  ) : (
                    <AssistantBubble
                      msg={item.message.msg}
                      isFirstInGroup={item.isFirstInGroup}
                      isLastInGroup={item.isLastInGroup}
                    />
                  )}
                </li>
              ),
            )}
          </ol>
        )}
      </div>

      {error ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          <span>{error}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={retry}
            disabled={streaming}
            className="h-6 px-2 text-[11px]"
          >
            Retry
          </Button>
        </div>
      ) : null}

      <div className="flex items-start gap-2">
        <label htmlFor={`ekko-chat-input-${creativeId}`} className="sr-only">
          Message Ekko
        </label>
        <textarea
          id={`ekko-chat-input-${creativeId}`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={2}
          className="min-h-[44px] flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={streaming}
        />
        {streaming ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={stop}
            className="h-9 gap-1"
            aria-label="Stop Ekko"
          >
            <StopCircle aria-hidden="true" className="h-3.5 w-3.5" />
            Stop
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() => void submit(input)}
            disabled={!input.trim()}
            className="h-9 gap-1"
            aria-label="Send to Ekko"
          >
            <Send aria-hidden="true" className="h-3.5 w-3.5" />
            Send
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function applyChunk(
  setMessages: React.Dispatch<React.SetStateAction<DisplayMessage[]>>,
  assistantId: string,
  chunk: StreamChunk,
  onToolSeen: () => void,
  textBufRef: React.MutableRefObject<Map<string, string>>,
  scheduleFlush: () => void,
) {
  // Text deltas: buffer + schedule a single RAF flush. This keeps the
  // React render rate decoupled from the upstream token rate.
  if (chunk.type === "text_delta") {
    const buf = textBufRef.current;
    const prev = buf.get(assistantId) ?? "";
    buf.set(assistantId, prev + chunk.delta);
    scheduleFlush();
    return;
  }

  // Everything else is sparse + meaningful — flush synchronously so
  // tool cards appear without a frame of delay.
  setMessages((prev) =>
    prev.map((m) => {
      if (m.kind !== "assistant" || m.id !== assistantId) return m;
      switch (chunk.type) {
        case "tool_call_start": {
          onToolSeen();
          // Open a new pending tool-call card for this turn. If we
          // already have a pending call for the same tool name (the
          // SDK can emit partial-json deltas under the same content
          // block), merge.
          const existing = m.toolCalls.findIndex((c) => c.tool === chunk.tool && c.pending);
          if (existing !== -1) {
            const merged: ToolCallView[] = m.toolCalls.map((c, i) =>
              i === existing ? { ...c, input: chunk.input ?? c.input } : c,
            );
            return { ...m, toolCalls: merged };
          }
          const next: ToolCallView = {
            id: newMessageId(),
            tool: chunk.tool,
            input: chunk.input,
            result: null,
            pending: true,
          };
          return { ...m, toolCalls: [...m.toolCalls, next] };
        }
        case "tool_call_result": {
          onToolSeen();
          const updated: ToolCallView[] = m.toolCalls.map((c) =>
            c.tool === chunk.tool && c.pending ? { ...c, result: chunk.result, pending: false } : c,
          );
          return { ...m, toolCalls: updated };
        }
        case "message_stop":
          return { ...m, streaming: false };
        case "error":
          return { ...m, streaming: false };
        default:
          return m;
      }
    }),
  );
}

function UserBubble({
  text,
  isFirstInGroup,
  isLastInGroup,
}: {
  text: string;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
}) {
  return (
    <div className="ml-auto max-w-[80%]" data-thread-searchable data-thread-search-role="user">
      <div
        className={cn(
          "bg-primary px-2.5 py-1.5 text-sm text-primary-foreground shadow-sm",
          isFirstInGroup ? "rounded-t-md" : "rounded-t-sm",
          isLastInGroup ? "rounded-b-md" : "rounded-b-sm",
          "rounded-l-md",
        )}
      >
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
    </div>
  );
}

function AssistantBubble({
  msg,
  isFirstInGroup,
  isLastInGroup,
}: {
  msg: Extract<DisplayMessage, { kind: "assistant" }>;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
}) {
  return (
    <div
      className="mr-auto max-w-[88%] space-y-1"
      data-thread-searchable
      data-thread-search-role="assistant"
    >
      {isFirstInGroup ? (
        <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-violet-700">
          Ekko
        </p>
      ) : null}
      <div
        className={cn(
          "border bg-card px-2.5 py-1.5 text-sm text-foreground shadow-sm",
          isFirstInGroup ? "rounded-t-md" : "rounded-t-sm",
          isLastInGroup ? "rounded-b-md" : "rounded-b-sm",
          "rounded-r-md",
          msg.streaming ? "border-violet-300" : "border-border",
        )}
      >
        {msg.text ? (
          <div className="prose prose-sm prose-zinc max-w-none break-words [&_code]:text-[12px] [&_p]:my-1 [&_pre]:my-1 [&_ul]:my-1">
            <ReactMarkdown>{msg.text}</ReactMarkdown>
          </div>
        ) : msg.streaming ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            Ekko is thinking…
          </p>
        ) : null}
      </div>
      {msg.toolCalls.length > 0 ? (
        <ul className="space-y-1">
          {msg.toolCalls.map((c) => (
            <li key={c.id}>
              <ToolCallCard call={c} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Exported for tests / debugging — lets callers see whether an id was
// assigned by the optimistic insert path. Not used by the runtime.
export const __testExports = { isTempId, newTempId };
