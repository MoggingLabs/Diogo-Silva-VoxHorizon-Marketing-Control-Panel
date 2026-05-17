"use client";

import { Hammer } from "lucide-react";

import type { ToolCallView } from "@/lib/chat";

import { CardShell, pickStringField } from "./shared";

/**
 * Catch-all card for tool calls without a dedicated renderer. Picks a
 * sensible one-line summary from common input fields and falls back to
 * a short JSON serialization. The full payload is still available
 * under the expand affordance.
 */
export function FallbackCard({ call }: { call: ToolCallView }) {
  const summary = pickStringField(call.input, [
    "prompt",
    "headline",
    "script",
    "voice_id",
    "clip_id",
    "message",
  ]);
  return (
    <CardShell
      icon={<Hammer aria-hidden="true" className="h-3.5 w-3.5 text-violet-700" />}
      tool={call.tool}
      summary={summary}
      pending={call.pending}
      input={call.input}
      result={call.result}
    />
  );
}
