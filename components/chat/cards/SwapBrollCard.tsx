"use client";

import { Film } from "lucide-react";

import type { ToolCallView } from "@/lib/chat";

import { CardShell, StatusPill } from "./shared";

/**
 * Renderer for `swap_broll`. The interesting payload fields are
 * `segment_idx` (which slot in the script) and `clip_id` (which
 * replacement clip); we render both as inline pills.
 */
export function SwapBrollCard({ call }: { call: ToolCallView }) {
  const segment = readNumber(call.input, "segment_idx");
  const clipId = readString(call.input, "clip_id");
  const summary = segmentSummary(segment, clipId);
  return (
    <CardShell
      icon={<Film aria-hidden="true" className="h-3.5 w-3.5 text-violet-700" />}
      tool={call.tool}
      summary={
        <>
          <span>{summary}</span>
          {segment !== null ? (
            <span className="ml-2 inline-flex">
              <StatusPill tone="info" label={`seg ${segment + 1}`} />
            </span>
          ) : null}
          {clipId ? (
            <span className="ml-1 inline-flex">
              <StatusPill tone="info" label={clipId} />
            </span>
          ) : null}
        </>
      }
      pending={call.pending}
      input={call.input}
      result={call.result}
    />
  );
}

function readNumber(input: unknown, key: string): number | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readString(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function segmentSummary(segment: number | null, clipId: string | null): string {
  if (segment === null && clipId === null) return "swapping b-roll…";
  if (segment !== null && clipId !== null) return `swap segment ${segment + 1} → ${clipId}`;
  if (segment !== null) return `swap segment ${segment + 1}`;
  return `swap to ${clipId}`;
}
