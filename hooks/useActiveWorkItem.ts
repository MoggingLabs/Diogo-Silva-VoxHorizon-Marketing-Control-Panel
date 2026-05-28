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
 *    INSERTs and UPDATEs both re-fetch the route -- the view-side reducer
 *    (`compute_pipeline_status`) is the single source of truth for derived
 *    status, so a client-side merge would risk diverging from it.
 *
 * Silent-failure PR-5: the subscription is now GATED. When the hook is seeded
 * (SSR) with NO active work_item it subscribes to INSERTs only -- it does NOT
 * open the full UPDATE stream and does NOT fetch on mount. This is the fix for
 * the PR-3 stall: mounting the panel slot on the ideation/review/generation
 * stages used to open a `*` subscription + fire a fetch on every stage mount,
 * which stalled the review->generation flow in CI. With the gate, an idle
 * pipeline opens the cheapest possible listener (INSERT-only) and escalates to
 * the full UPDATE stream + refetch the moment a work_item actually appears.
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

  // Gate for the realtime stream (PR-5). We open it when the SSR seed carried
  // an active work_item, or when no seed was provided at all (legacy callers
  // that always want the live stream). When seeded with NO active work_item we
  // register an empty listener set so no channel opens -- the page re-seeds via
  // `router.refresh()` once a work_item appears, which remounts this hook with
  // a non-null seed and flips the gate on.
  const seededIdle = initialState !== undefined && initialState.activeWorkItem == null;
  const streamActive = !seededIdle;

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
  //
  // The listener set is GATED on `streamActive` (PR-5). When the hook is
  // seeded (SSR) with NO active work_item we register an EMPTY listener set:
  // `useRealtimeStream` short-circuits on an empty spec and never opens the
  // SSE connection (no `.channel()` / EventSource). This is the anti-stall
  // gate -- an idle stage that mounts the panel never opens a channel and
  // never fires the work-state fetch. The full `*` listener only opens once
  // the pipeline actually has an active work_item (seeded non-null, or a
  // refetch surfaced one). The slot wrapper below is the outer gate that
  // keeps the hook from mounting at all while idle; this inner gate is the
  // belt-and-braces for any caller that mounts the panel directly.
  useRealtimeStream(
    useMemo(
      () =>
        pipelineId && streamActive
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
      [pipelineId, refetch, streamActive],
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
