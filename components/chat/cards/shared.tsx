"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Shared building blocks for structured tool-call cards.
 *
 * Each renderer wraps its content in `<CardShell />` so every variant
 * gets the same expand/collapse affordance, status dot, and
 * details-pane styling. Renderers stay focused on their own pretty-
 * printed inputs and result handling.
 */

export type CardShellProps = {
  icon: React.ReactNode;
  /** Lowercased tool name; rendered as a monospace pill. */
  tool: string;
  summary: React.ReactNode;
  pending: boolean;
  /** Pretty-printed JSON of the tool input. */
  input: unknown;
  /** Pretty-printed JSON of the tool result (or null while pending). */
  result: unknown;
  children?: React.ReactNode;
};

export function CardShell({
  icon,
  tool,
  summary,
  pending,
  input,
  result,
  children,
}: CardShellProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/50 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-violet-100/60"
        aria-expanded={expanded}
      >
        <span className="mt-0.5 inline-flex items-center gap-1 text-violet-700">
          {expanded ? (
            <ChevronDown aria-hidden="true" className="h-3 w-3" />
          ) : (
            <ChevronRight aria-hidden="true" className="h-3 w-3" />
          )}
          <span className="inline-flex h-3.5 w-3.5 items-center justify-center">{icon}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-mono text-[11px] font-medium text-violet-900">{tool}</span>
          <span className="ml-1 text-violet-700/90">· {summary}</span>
        </span>
        <span className="ml-1 inline-flex items-center gap-1 text-violet-700">
          {pending ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 text-emerald-600" />
          )}
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-violet-200/70 px-2.5 py-2 text-[11px]">
          {children}
          <p className="mt-2 font-semibold text-violet-900">Input</p>
          <pre className="mt-0.5 max-h-32 overflow-auto rounded bg-white px-2 py-1 font-mono text-[10px] text-zinc-800">
            {prettyJson(input)}
          </pre>
          {result !== null && result !== undefined ? (
            <>
              <p className="mt-2 font-semibold text-violet-900">Result</p>
              <pre className="mt-0.5 max-h-32 overflow-auto rounded bg-white px-2 py-1 font-mono text-[10px] text-zinc-800">
                {prettyJson(result)}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function prettyJson(value: unknown): string {
  if (value === undefined || value === null) return "(null)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Pick a sensible one-line text summary from a tool-call input dict.
 * Falls back to a short JSON serialization when no known key is set.
 */
export function pickStringField(
  input: unknown,
  fields: string[],
  fallback = "(no input yet)",
): string {
  if (input == null) return fallback;
  if (typeof input === "string") {
    const s = input.trim();
    return s.length === 0 ? fallback : s.length > 120 ? `${s.slice(0, 117)}…` : s;
  }
  if (typeof input !== "object") return String(input);
  const rec = input as Record<string, unknown>;
  for (const key of fields) {
    const v = rec[key];
    if (typeof v === "string" && v.trim().length > 0) {
      const s = v.trim();
      return s.length > 120 ? `${s.slice(0, 117)}…` : s;
    }
  }
  try {
    return JSON.stringify(input).slice(0, 120);
  } catch {
    return "…";
  }
}

/**
 * Small inline status badge used by some cards. Keeps the visual
 * vocabulary consistent across variants.
 */
export function StatusPill({ label, tone }: { label: string; tone: "ok" | "warn" | "info" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        tone === "ok" && "bg-emerald-100 text-emerald-700",
        tone === "warn" && "bg-amber-100 text-amber-700",
        tone === "info" && "bg-violet-100 text-violet-700",
      )}
    >
      {label}
    </span>
  );
}
