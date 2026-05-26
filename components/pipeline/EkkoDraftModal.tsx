"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles, StopCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  newMessageId,
  readChatStream,
  type ChatMessageT,
  type DisplayMessage,
  type StreamChunk,
  type ToolCallView,
} from "@/lib/chat";
import { cn } from "@/lib/utils";

/**
 * Payload Ekko hands back when she's confident a draft is ready. Mirrors the
 * worker tool schema in `worker/src/routes/pipeline.py::_propose_config_tool`.
 * The inner brief shapes are intentionally typed as `unknown` here — the
 * parent StageConfiguration hydrates the form via the same untyped path that
 * autosave uses, and the canonical zod parse runs at advance time.
 */
export type ProposedConfig = {
  format_choice: "image" | "video" | "both";
  image_payload?: Record<string, unknown> | null;
  video_payload?: Record<string, unknown> | null;
  notes?: string;
};

export type EkkoDraftModalProps = {
  pipelineId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fired once when Ekko emits the `propose_config` tool_call_result.
   * The modal hands the parent the raw payload; the parent decides how
   * to merge it into the form state.
   */
  onProposed: (proposal: ProposedConfig) => void;
};

/**
 * Modal that runs a streaming Ekko brief-strategist interview. Three-to-five
 * exchanges in, the worker emits a `tool_call_result` with `tool ===
 * 'propose_config'`; the modal forwards the payload to `onProposed` and shows
 * a confirmation banner. The operator can then close the modal and review /
 * edit the hydrated form.
 *
 * Implementation notes:
 *   - We reuse `lib/chat.ts`'s `readChatStream` parser, so the wire format
 *     stays in lock-step with the existing creative chat surface.
 *   - Cancel aborts the local fetch immediately and closes the modal. The
 *     server-side SSE proxy propagates the abort via `req.signal` so the
 *     worker terminates its Anthropic call too — no separate abort POST is
 *     needed for the short-lived pipeline draft session.
 *   - The transcript intentionally lives in component state (not lifted)
 *     because closing the modal discards the conversation: a fresh open
 *     starts a new interview with Ekko, which is what the operator wants.
 */
export function EkkoDraftModal({
  pipelineId,
  open,
  onOpenChange,
  onProposed,
}: EkkoDraftModalProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposedAt, setProposedAt] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inflightAssistantIdRef = useRef<string | null>(null);

  // Reset when the modal opens or closes — each session is a fresh interview.
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      setStreaming(false);
      return;
    }
    // Seed the transcript with Ekko's opening prompt so the operator has
    // something to react to. Marked non-streaming.
    setMessages([
      {
        kind: "assistant",
        id: newMessageId(),
        text:
          "Hi — I'm Ekko. Tell me about the campaign you want to run and " +
          "I'll draft a brief for you. To start: what's the service line " +
          "(roofing or remodeling), and which city or market are we " +
          "targeting?",
        toolCalls: [],
        streaming: false,
      },
    ]);
    setInput("");
    setError(null);
    setProposedAt(null);
  }, [open]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Cleanup any inflight stream when the component unmounts.
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

      const userId = newMessageId();
      const assistantId = newMessageId();
      const userMsg: DisplayMessage = { kind: "user", id: userId, text: trimmed };
      const assistantMsg: DisplayMessage = {
        kind: "assistant",
        id: assistantId,
        text: "",
        toolCalls: [],
        streaming: true,
      };
      inflightAssistantIdRef.current = assistantId;

      // Build wire history from the current view plus the new user message.
      // We drop assistant turns with empty text (the streaming placeholder)
      // because the API requires non-empty content.
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

      try {
        const response = await fetch(
          `/api/pipelines/${encodeURIComponent(pipelineId)}/config/draft`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: wireHistory }),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          let payload: { error?: string } | null = null;
          try {
            payload = await response.json();
          } catch {
            /* ignore */
          }
          throw new Error(payload?.error ?? `draft failed: HTTP ${response.status}`);
        }

        for await (const chunk of readChatStream(response, controller.signal)) {
          applyChunk(setMessages, assistantId, chunk, (proposal) => {
            setProposedAt(new Date().toISOString());
            onProposed(proposal);
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
        setMessages((prev) =>
          prev.map((m) => {
            if (m.kind !== "assistant" || m.id !== assistantId) return m;
            return {
              ...m,
              streaming: false,
              toolCalls: m.toolCalls.map((c) => ({ ...c, pending: false })),
            };
          }),
        );
        setStreaming(false);
        abortRef.current = null;
        inflightAssistantIdRef.current = null;
      }
    },
    [messages, onProposed, pipelineId, streaming],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        void submit(input);
      }
    },
    [input, submit],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          // Closing — abort any inflight stream cleanly.
          abortRef.current?.abort();
          abortRef.current = null;
          setStreaming(false);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
            Let Ekko draft this
          </DialogTitle>
          <DialogDescription>
            Answer a few quick questions and Ekko will pre-fill the brief form. Everything stays
            editable after.
          </DialogDescription>
        </DialogHeader>

        {proposedAt ? (
          <div
            role="status"
            className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success"
          >
            Draft delivered — close this dialog to review and edit the form.
          </div>
        ) : null}

        <div
          ref={scrollRef}
          className="max-h-[50vh] min-h-[200px] flex-1 overflow-y-auto rounded-md border bg-card p-3"
          aria-live="polite"
        >
          <ol className="space-y-3">
            {messages.map((m) =>
              m.kind === "user" ? (
                <li key={m.id} className="flex">
                  <div className="ml-auto max-w-[80%] rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground shadow-sm">
                    <p className="whitespace-pre-wrap break-words">{m.text}</p>
                  </div>
                </li>
              ) : (
                <li key={m.id} className="mr-auto max-w-[88%] space-y-1">
                  <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-accent">
                    Ekko
                  </p>
                  <div
                    className={cn(
                      "rounded-md border bg-card px-3 py-1.5 text-sm text-foreground shadow-sm",
                      m.streaming ? "border-accent/40" : "border-border",
                    )}
                  >
                    {m.text ? (
                      <div className="prose prose-sm prose-zinc max-w-none break-words [&_p]:my-1">
                        <ReactMarkdown>{m.text}</ReactMarkdown>
                      </div>
                    ) : m.streaming ? (
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                        Ekko is thinking…
                      </p>
                    ) : null}
                  </div>
                  {m.toolCalls.length > 0 ? (
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {m.toolCalls.map((c) => (
                        <li key={c.id} className="rounded-sm bg-muted px-2 py-1">
                          {c.tool === "propose_config" ? (
                            <span>
                              Drafted a{" "}
                              {String(
                                (c.result as { format_choice?: string } | null)?.format_choice ??
                                  "brief",
                              )}{" "}
                              brief.
                            </span>
                          ) : (
                            <span>Tool: {c.tool}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ),
            )}
          </ol>
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
          >
            {error}
          </div>
        ) : null}

        <div className="flex items-start gap-2">
          <label htmlFor={`ekko-draft-input-${pipelineId}`} className="sr-only">
            Reply to Ekko
          </label>
          <textarea
            id={`ekko-draft-input-${pipelineId}`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type your answer…"
            rows={2}
            disabled={streaming || proposedAt !== null}
            className="min-h-[44px] flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
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
              <StopCircle className="h-3.5 w-3.5" aria-hidden="true" />
              Stop
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => void submit(input)}
              disabled={!input.trim() || proposedAt !== null}
              className="h-9 gap-1"
              aria-label="Send to Ekko"
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              Send
            </Button>
          )}
        </div>

        <div className="flex flex-row-reverse gap-2">
          <Button
            type="button"
            variant={proposedAt ? "default" : "outline"}
            onClick={() => onOpenChange(false)}
          >
            {proposedAt ? "Review draft" : "Cancel"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Apply one SSE chunk to the modal's message list. Mirrors the small
 * applyChunk helper in `<EkkoChat />` but specialised to surface
 * `tool_call_result` with tool === 'propose_config' to the parent via
 * `onProposed`.
 *
 * Text deltas are appended directly (no RAF batching here — the modal is
 * a short-lived interview so the render cost is trivial).
 */
function applyChunk(
  setMessages: React.Dispatch<React.SetStateAction<DisplayMessage[]>>,
  assistantId: string,
  chunk: StreamChunk,
  onProposed: (proposal: ProposedConfig) => void,
) {
  if (chunk.type === "text_delta") {
    setMessages((prev) =>
      prev.map((m) =>
        m.kind === "assistant" && m.id === assistantId ? { ...m, text: m.text + chunk.delta } : m,
      ),
    );
    return;
  }

  setMessages((prev) =>
    prev.map((m) => {
      if (m.kind !== "assistant" || m.id !== assistantId) return m;
      switch (chunk.type) {
        case "tool_call_start": {
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
          if (chunk.tool === "propose_config") {
            const proposal = coerceProposed(chunk.result);
            if (proposal) onProposed(proposal);
          }
          const updated: ToolCallView[] = m.toolCalls.map((c) =>
            c.tool === chunk.tool && c.pending ? { ...c, result: chunk.result, pending: false } : c,
          );
          // If we never saw the tool_call_start (some SDK paths skip
          // the start frame), synthesize a finished card here so the
          // operator sees the interaction logged.
          if (updated.findIndex((c) => c.tool === chunk.tool && c.result !== null) === -1) {
            updated.push({
              id: newMessageId(),
              tool: chunk.tool,
              input: null,
              result: chunk.result,
              pending: false,
            });
          }
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

/**
 * Validate the propose_config result shape just enough to safely forward
 * it. We don't full-zod-parse here — the brief payloads pass through
 * autosave then through canonical validation at advance time.
 */
function coerceProposed(raw: unknown): ProposedConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const fc = r.format_choice;
  if (fc !== "image" && fc !== "video" && fc !== "both") return null;
  return {
    format_choice: fc,
    image_payload: isPlainObj(r.image_payload) ? r.image_payload : null,
    video_payload: isPlainObj(r.video_payload) ? r.video_payload : null,
    notes: typeof r.notes === "string" ? r.notes : undefined,
  };
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
