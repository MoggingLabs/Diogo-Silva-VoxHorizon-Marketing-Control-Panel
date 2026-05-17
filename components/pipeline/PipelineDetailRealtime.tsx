"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { createClient as createBrowserClient } from "@/lib/supabase/browser";

/**
 * Subscribes to both `pipelines` (filtered to this id) and `pipeline_events`
 * (filtered to `pipeline_id`) and calls `router.refresh()` whenever something
 * changes. Renderless — drop it into the detail page and let it sit there.
 *
 * Both filters use `eq` against the realtime publication so we only get the
 * notifications relevant to the open pipeline.
 */
export function PipelineDetailRealtime({ pipelineId }: { pipelineId: string }) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createBrowserClient();
    const channel = supabase
      .channel(`pipeline:${pipelineId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "pipelines",
          filter: `id=eq.${pipelineId}`,
        },
        () => router.refresh(),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "pipeline_events",
          filter: `pipeline_id=eq.${pipelineId}`,
        },
        () => router.refresh(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [pipelineId, router]);

  return null;
}
