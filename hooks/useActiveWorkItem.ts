"use client";

import { useEffect, useMemo, useState } from "react";

import { useRealtimeStream } from "@/hooks/useRealtimeStream";
import type { PipelineDispatchState, PipelineEventRow, WorkItem } from "@/lib/work-queue/types";
import type { Database } from "@/lib/supabase/types.gen";

/**
 * Silent-failure PR-2a: the dashboard's "what is the dispatcher doing right
 * now?" hook.
 *
 * Behaviour:
 *  - SSR-friendly: an optional `initialState` seeds the first paint when the
 *    page-level server component pre-fetched
 *    `/api/pipelines/[id]/work-state`.
 *  - On mount (or when `initialState` is omitted) the hook fetches the same
 *    route client-side. The response is the same envelope the route returns.
 *  - Subscribes to `work_item` filtered on `pipeline_id` via the SSE relay.
 *    INSERTs and UPDATEs both re-fetch the route — the view-side reducer
 *    (`compute_pipeline_status`) is the single source of truth for derived
 *    status, so a client-side merge would risk diverging from it.
 *
 * Returns `{ activeWorkItem, recentEvents, derivedStatus, isLoading, error }`
 * so the WorkItemPanel can render the seven status states + the timeline
 * preview off one consistent shape.
 */

export type UseActiveWorkItemResult = {
  activeWorkItem: WorkItem | null;
  recentEvents: PipelineEventRow[];
  derivedStatus: Database["public"]["Enums"]["pipeline_status_enum"] | null;
  isLoading: boolean;
  error: string | null;
};

export type UseActiveWorkItemOptions = {
  /** SSR-seeded initial state to skip the first fetch. */
  initialState?: PipelineDispatchState;
  /** Override the fetch URL (tests). */
  url?: string;
};

export function useActiveWorkItem(
  pipelineId: string,
  options: UseActiveWorkItemOptions = {},
): UseActiveWorkItemResult {
  const { initialState, url } = options;
  const endpoint = url ?? `/api/pipelines/${pipelineId}/work-state`;

  const [state, setState] = useState<{
    activeWorkItem: WorkItem | null;
    recentEvents: PipelineEventRow[];
    derivedStatus: Database["public"]["Enums"]["pipeline_status_enum"] | null;
  }>(() => ({
    activeWorkItem: initialState?.activeWorkItem ?? null,
    recentEvents: initialState?.recentEvents ?? [],
    derivedStatus: initialState?.derivedStatus ?? null,
  }));
  const [isLoading, setLoading] = useState(initialState === undefined);
  const [error, setError] = useState<string | null>(null);

  const refetch = useMemo(
    () => async (signal?: AbortSignal) => {
      try {
        const res = await fetch(endpoint, { cache: "no-store", signal });
        if (!res.ok) {
          setError(`work-state ${res.status}`);
          return;
        }
        const body: PipelineDispatchState = await res.json();
        setState({
          activeWorkItem: body.activeWorkItem,
          recentEvents: body.recentEvents,
          derivedStatus: body.derivedStatus,
        });
        setError(null);
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [endpoint],
  );

  // Initial fetch when there is no SSR seed.
  useEffect(() => {
    if (initialState !== undefined) return;
    const ctrl = new AbortController();
    void refetch(ctrl.signal);
    return () => ctrl.abort();
    // We deliberately only re-fetch when the pipeline id changes; the
    // initialState is a one-shot seed and changing it during a session would
    // be unusual (caller would unmount and remount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineId, endpoint]);

  // Realtime subscription: any work_item change for this pipeline triggers
  // a refetch. We don't merge client-side because `derived_status` is a
  // server-computed function over `pipeline_events`.
  useRealtimeStream(
    useMemo(
      () =>
        pipelineId
          ? [
              {
                table: "work_item",
                event: "*" as const,
                filter: `pipeline_id=eq.${pipelineId}`,
                callback: () => {
                  void refetch();
                },
              },
            ]
          : [],
      [pipelineId, refetch],
    ),
  );

  return {
    activeWorkItem: state.activeWorkItem,
    recentEvents: state.recentEvents,
    derivedStatus: state.derivedStatus,
    isLoading,
    error,
  };
}
