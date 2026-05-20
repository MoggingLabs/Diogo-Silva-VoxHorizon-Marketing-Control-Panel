"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";

import { useRealtimeStream } from "@/hooks/useRealtimeStream";

/**
 * Subscribes to both `pipelines` (filtered to this id) and `pipeline_events`
 * (filtered to `pipeline_id`) and calls `router.refresh()` whenever something
 * changes. Renderless — drop it into the detail page and let it sit there.
 *
 * Both filters use `eq` against the relay so we only get the notifications
 * relevant to the open pipeline. Realtime now flows through the server-side
 * SSE relay (`/api/realtime`) instead of a direct anon Supabase channel.
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
      ],
      [pipelineId, router],
    ),
  );

  return null;
}
