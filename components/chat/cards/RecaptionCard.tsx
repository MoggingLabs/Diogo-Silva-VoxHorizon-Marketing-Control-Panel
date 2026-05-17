"use client";

import { Type } from "lucide-react";

import type { ToolCallView } from "@/lib/chat";

import { CardShell, StatusPill, pickStringField } from "./shared";

/**
 * Renderer for `recaption`. Shows the chosen caption style + tone so
 * the operator can verify which Submagic preset ran.
 */
export function RecaptionCard({ call }: { call: ToolCallView }) {
  const style = readField(call.input, "style") ?? readField(call.input, "preset");
  const summary = pickStringField(
    call.input,
    ["style", "preset", "tone"],
    "regenerating captions…",
  );
  return (
    <CardShell
      icon={<Type aria-hidden="true" className="h-3.5 w-3.5 text-violet-700" />}
      tool={call.tool}
      summary={
        <>
          <span>{summary}</span>
          {style ? (
            <span className="ml-2 inline-flex">
              <StatusPill tone="info" label={style} />
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

function readField(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
