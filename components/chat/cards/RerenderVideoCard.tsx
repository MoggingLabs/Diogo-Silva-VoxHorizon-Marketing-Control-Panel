"use client";

import { RotateCw } from "lucide-react";

import type { ToolCallView } from "@/lib/chat";

import { CardShell } from "./shared";

/**
 * Renderer for `rerender_video` — a no-input tool that kicks off a
 * fresh ffmpeg composite. We render it as a compact card because the
 * action is "do the thing" rather than "do X with Y".
 */
export function RerenderVideoCard({ call }: { call: ToolCallView }) {
  return (
    <CardShell
      icon={<RotateCw aria-hidden="true" className="h-3.5 w-3.5 text-violet-700" />}
      tool={call.tool}
      summary={call.pending ? "rerendering composed MP4…" : "composite refreshed"}
      pending={call.pending}
      input={call.input}
      result={call.result}
    />
  );
}
