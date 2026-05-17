"use client";

import { Mic } from "lucide-react";

import type { ToolCallView } from "@/lib/chat";

import { CardShell, StatusPill, pickStringField } from "./shared";

/**
 * Renderer for `regenerate_voiceover`. Surfaces the chosen voice id +
 * script preview so the operator can verify which TTS regen ran.
 */
export function RegenerateVoiceoverCard({ call }: { call: ToolCallView }) {
  const voiceId = readField(call.input, "voice_id");
  const summary = pickStringField(call.input, ["script", "voice_id"], "regenerating voiceover…");
  return (
    <CardShell
      icon={<Mic aria-hidden="true" className="h-3.5 w-3.5 text-violet-700" />}
      tool={call.tool}
      summary={
        <>
          <span>{summary}</span>
          {voiceId ? (
            <span className="ml-2 inline-flex">
              <StatusPill tone="info" label={`voice: ${voiceId}`} />
            </span>
          ) : null}
        </>
      }
      pending={call.pending}
      input={call.input}
      result={call.result}
    >
      {voiceId ? (
        <p className="font-mono text-[10px] text-violet-900">voice_id = {voiceId}</p>
      ) : null}
    </CardShell>
  );
}

function readField(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
