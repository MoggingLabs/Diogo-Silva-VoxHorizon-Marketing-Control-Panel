"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

import { ToolCallCard } from "./ToolCallCard";

/**
 * Format-agnostic chat surface for the Side Panel.
 *
 * Renders a stream of messages, supports markdown in assistant replies,
 * and renders inline tool calls via `<ToolCallCard />`. Submitting a
 * message POSTs the full history to the chat API route, then consumes
 * the SSE response and updates the in-flight assistant message in
 * place.
 *
 * Props:
 *  - `endpoint`: the chat API URL — usually `/api/creatives/[id]/chat`
 *    or `/api/creatives/video/[id]/chat`. Already authorised on the
 *    server.
 *  - `creativeId`: ID of the creative this chat belongs to. Used in
 *    the placeholder text and for analytics-style logs.
 *  - `creativeKind`: "image" or "video"; tweaks tone-of-voice.
 *  - `onIterate`: callback fired when an assistant turn finishes
 *    AND included at least one `tool_call_result`. The parent uses
 *    this to refresh the iteration thread / preview pane.
 */
export type EkkoChatProps = {
  endpoint: string;
  creativeId: string;
  creativeKind: "image" | "video";
  onIterate?: () => void;
  /** Optional class for the outer container, for parent layout tweaks. */
  className?: string;
};

export function EkkoChat({
  endpoint,
  creativeId,
  creativeKind,
  onIterate,
  className,
}: EkkoChatProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the bottom whenever messages change.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Reset when the creative changes — different chat history per id.
  useEffect(() => {
    setMessages([]);
    setInput("");
    setError(null);
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, [creativeId]);

  // Cancel any inflight stream on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;
      setError(null);

      const userMsg: DisplayMessage = {
        kind: "user",
        id: newMessageId(),
        text: trimmed,
      };
      const assistantMsg: DisplayMessage = {
        kind: "assistant",
        id: newMessageId(),
        text: "",
        toolCalls: [],
        streaming: true,
      };

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
      setInput("");
      setStreaming(true);

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
          applyChunk(setMessages, assistantMsg.id, chunk, () => {
            sawTool = true;
          });
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
        // Mark the assistant message as no-longer-streaming and clear
        // any in-flight tool spinners (best-effort — the server should
        // have closed them but the operator may have hit Stop).
        setMessages((prev) =>
          prev.map((m) =>
            m.kind === "assistant" && m.id === assistantMsg.id
              ? {
                  ...m,
                  streaming: false,
                  toolCalls: m.toolCalls.map((c) => ({ ...c, pending: false })),
                }
              : m,
          ),
        );
        setStreaming(false);
        abortRef.current = null;
        if (sawTool) onIterate?.();
      }
    },
    [endpoint, messages, onIterate, streaming],
  );

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

  return (
    <div className={cn("flex h-full flex-col gap-2", className)}>
      <div
        ref={scrollRef}
        className="max-h-[480px] min-h-[120px] flex-1 overflow-y-auto rounded-md border bg-card p-2"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <p className="px-1 py-3 text-center text-xs text-muted-foreground">
            Start a conversation with Ekko about this creative.
          </p>
        ) : (
          <ol className="space-y-2">
            {messages.map((m) => (
              <li key={m.id} className="flex gap-2">
                {m.kind === "user" ? <UserBubble text={m.text} /> : <AssistantBubble msg={m} />}
              </li>
            ))}
          </ol>
        )}
      </div>

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {error}
        </p>
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
) {
  setMessages((prev) =>
    prev.map((m) => {
      if (m.kind !== "assistant" || m.id !== assistantId) return m;
      switch (chunk.type) {
        case "text_delta":
          return { ...m, text: m.text + chunk.delta };
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

function UserBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto max-w-[80%]">
      <div className="rounded-md bg-primary px-2.5 py-1.5 text-sm text-primary-foreground shadow-sm">
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
    </div>
  );
}

function AssistantBubble({ msg }: { msg: Extract<DisplayMessage, { kind: "assistant" }> }) {
  return (
    <div className="mr-auto max-w-[88%] space-y-1">
      <div
        className={cn(
          "rounded-md border bg-card px-2.5 py-1.5 text-sm text-foreground shadow-sm",
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
