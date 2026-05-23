"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";

import { useRealtimeStream } from "@/hooks/useRealtimeStream";

/**
 * Subscribes to `pipelines` (filtered to this id), `pipeline_events`, and the
 * per-creative `creative_stage_state` (all filtered to `pipeline_id`) and calls
 * `router.refresh()` whenever something changes. Renderless — drop it into the
 * detail page and let it sit there.
 *
 * The `creative_stage_state` subscription (P4.8, #363) keeps the
 * CreativeReviewGrid's per-creative pills live: when the worker writes a QA /
 * compliance / copy / spec verdict, the row update streams through the SSE relay
 * and the server-rendered grid re-fetches via `router.refresh()`. The
 * server-side gates re-derive autonomy (`lib/approval-mode/autonomy.ts`) so a
 * hard gate never auto-passes on a realtime update.
 *
 * All filters use `eq` against the relay so we only get the notifications
 * relevant to the open pipeline. Realtime flows through the server-side SSE
 * relay (`/api/realtime`) instead of a direct anon Supabase channel.
 */
export function PipelineDetailRealtime({ pipelineId }: { pipelineId: string }) {
  const router = useRouter();

  useRealtimeStream(
    useMemo(
      () => [
        {
          table: "pipelines",
          event: "*" as const,
          filter: `id=eq.${pipelineId}`,
          callback: () => router.refresh(),
        },
        {
          table: "pipeline_events",
          event: "*" as const,
          filter: `pipeline_id=eq.${pipelineId}`,
          callback: () => router.refresh(),
        },
        {
          table: "creative_stage_state",
          event: "*" as const,
          filter: `pipeline_id=eq.${pipelineId}`,
          callback: () => router.refresh(),
        },
      ],
      [pipelineId, router],
    ),
  );

  return null;
}
