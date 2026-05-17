"use client";

import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Hammer,
  Loader2,
  Paintbrush,
  RefreshCw,
  ScanSearch,
  Sparkles,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { ToolCallView } from "@/lib/chat";

/**
 * Inline card for one tool call. Renders a one-line summary by default;
 * the operator can expand to see the full input + result JSON.
 *
 * Visual states:
 *  - `pending`: spinner icon, "in flight" text
 *  - resolved (`result != null`): checkmark icon, "done"
 *
 * Tool icons map known names to lucide icons so the card has a quick
 * visual scan. Unknown tools fall back to the wrench.
 */

export type ToolCallCardProps = {
  call: ToolCallView;
};

const TOOL_ICONS: Record<string, typeof Hammer> = {
  regenerate_image: RefreshCw,
  composite_image: Paintbrush,
  regenerate_voiceover: Sparkles,
  swap_broll: ScanSearch,
  rerender_video: RefreshCw,
};

function iconFor(tool: string): typeof Hammer {
  return TOOL_ICONS[tool] ?? Hammer;
}

function summarize(input: unknown): string {
  if (input == null) return "(no input yet)";
  if (typeof input === "string") return input.slice(0, 120);
  if (typeof input !== "object") return String(input);
  try {
    // Pick a sensible one-line field if we recognise it.
    const rec = input as Record<string, unknown>;
    for (const key of ["prompt", "headline", "script", "voice_id", "clip_id"]) {
      const v = rec[key];
      if (typeof v === "string" && v.trim().length > 0) {
        return v.length > 120 ? `${v.slice(0, 117)}…` : v;
      }
    }
    return JSON.stringify(input).slice(0, 120);
  } catch {
    return "…";
  }
}

function prettyJson(value: unknown): string {
  if (value === undefined || value === null) return "(null)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ToolCallCard({ call }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const Icon = iconFor(call.tool);
  const StatusIcon = call.pending ? Loader2 : CheckCircle2;
  const summary = summarize(call.input);

  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/50 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-violet-100/60"
        aria-expanded={expanded}
      >
        <span className="mt-0.5 inline-flex items-center gap-1">
          {expanded ? (
            <ChevronDown aria-hidden="true" className="h-3 w-3 text-violet-700" />
          ) : (
            <ChevronRight aria-hidden="true" className="h-3 w-3 text-violet-700" />
          )}
          <Icon aria-hidden="true" className="h-3.5 w-3.5 text-violet-700" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-mono text-[11px] font-medium text-violet-900">{call.tool}</span>
          <span className="ml-1 text-violet-700/90">· {summary}</span>
        </span>
        <span className="ml-1 inline-flex items-center gap-1 text-violet-700">
          <StatusIcon
            aria-hidden="true"
            className={cn("h-3.5 w-3.5", call.pending ? "animate-spin" : "text-emerald-600")}
          />
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-violet-200/70 px-2.5 py-2 text-[11px]">
          <p className="font-semibold text-violet-900">Input</p>
          <pre className="mt-0.5 max-h-32 overflow-auto rounded bg-white px-2 py-1 font-mono text-[10px] text-zinc-800">
            {prettyJson(call.input)}
          </pre>
          {call.result !== null && call.result !== undefined ? (
            <>
              <p className="mt-2 font-semibold text-violet-900">Result</p>
              <pre className="mt-0.5 max-h-32 overflow-auto rounded bg-white px-2 py-1 font-mono text-[10px] text-zinc-800">
                {prettyJson(call.result)}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
