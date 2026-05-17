"use client";

import { RefreshCw } from "lucide-react";

import type { ToolCallView } from "@/lib/chat";

import { CardShell, StatusPill, pickStringField } from "./shared";

/**
 * Renderer for the `regenerate_image` tool call.
 *
 * Highlights the prompt + output ratio so the operator can scan a
 * thread and see at a glance which regenerations targeted which
 * concept.
 */
export function RegenerateImageCard({ call }: { call: ToolCallView }) {
  const summary = pickStringField(call.input, ["prompt"], "regenerating…");
  const ratio = readRatio(call.input);
  return (
    <CardShell
      icon={<RefreshCw aria-hidden="true" className="h-3.5 w-3.5 text-violet-700" />}
      tool={call.tool}
      summary={
        <>
          <span>{summary}</span>
          {ratio ? (
            <span className="ml-2 inline-flex">
              <StatusPill tone="info" label={ratio} />
            </span>
          ) : null}
        </>
      }
      pending={call.pending}
      input={call.input}
      result={call.result}
    >
      <p className="font-semibold text-violet-900">Prompt</p>
      <p className="mt-0.5 whitespace-pre-wrap break-words rounded bg-white px-2 py-1 text-[11px] text-zinc-800">
        {summary}
      </p>
    </CardShell>
  );
}

function readRatio(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const r = (input as Record<string, unknown>).ratio;
  return typeof r === "string" && r.length > 0 ? r : null;
}
