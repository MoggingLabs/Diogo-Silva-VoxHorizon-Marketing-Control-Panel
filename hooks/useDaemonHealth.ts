"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useRealtimeStream } from "@/hooks/useRealtimeStream";
import {
  deriveDaemonFreshness,
  type DaemonFreshness,
  type WorkItemConsumer,
} from "@/lib/work-queue/types";

/**
 * Silent-failure PR-2a: hook that drives `DaemonHealthBadge`.
 *
 * Behaviour:
 *  - SSR-friendly: optional `initialConsumer` skips the first fetch.
 *  - On mount fetches `/api/operator/daemon-health` to hydrate.
 *  - Subscribes to `work_item_consumers` filtered on `kind=eq.operator_dispatch`
 *    via the SSE relay so the badge flips green within milliseconds of the
 *    daemon writing its `status='live'` row.
 *  - Recomputes `freshness` every 10s from the cached `last_seen_at` so a
 *    daemon that stops heartbeating quietly turns the badge yellow without
 *    waiting for a realtime push that will never arrive.
 */

export type UseDaemonHealthResult = {
  consumer: WorkItemConsumer | null;
  freshness: DaemonFreshness;
  isLoading: boolean;
  error: string | null;
};

export type UseDaemonHealthOptions = {
  /** SSR-seeded initial consumer row to skip the first fetch. */
  initialConsumer?: WorkItemConsumer | null;
  /** Override the fetch URL (tests). */
  url?: string;
  /** Override the staleness tick interval in ms (tests). Default 10s. */
  tickIntervalMs?: number;
};

export function useDaemonHealth(options: UseDaemonHealthOptions = {}): UseDaemonHealthResult {
  const { initialConsumer, url, tickIntervalMs = 10_000 } = options;
  const endpoint = url ?? "/api/operator/daemon-health";

  const seeded = initialConsumer !== undefined;
  const [consumer, setConsumer] = useState<WorkItemConsumer | null>(initialConsumer ?? null);
  const [freshness, setFreshness] = useState<DaemonFreshness>(
    deriveDaemonFreshness(initialConsumer ?? null),
  );
  const [isLoading, setLoading] = useState(!seeded);
  const [error, setError] = useState<string | null>(null);

  // Hold the latest consumer in a ref so the tick interval can re-derive
  // without re-subscribing every state change.
  const consumerRef = useRef<WorkItemConsumer | null>(initialConsumer ?? null);
  consumerRef.current = consumer;

  const refetch = useMemo(
    () => async (signal?: AbortSignal) => {
      try {
        const res = await fetch(endpoint, { cache: "no-store", signal });
        if (!res.ok) {
          setError(`daemon-health ${res.status}`);
          return;
        }
        const body: { consumer: WorkItemConsumer | null; freshness: DaemonFreshness } =
          await res.json();
        setConsumer(body.consumer);
        setFreshness(deriveDaemonFreshness(body.consumer));
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

  // Initial fetch — only when there's no SSR seed.
  useEffect(() => {
    if (seeded) return;
    const ctrl = new AbortController();
    void refetch(ctrl.signal);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  // Periodic re-derivation so a daemon that quietly stopped heartbeating
  // flips to 'stale' without needing a realtime push.
  useEffect(() => {
    const id = setInterval(() => {
      setFreshness(deriveDaemonFreshness(consumerRef.current));
    }, tickIntervalMs);
    return () => clearInterval(id);
  }, [tickIntervalMs]);

  // Realtime: any consumer-row change for the operator queue triggers a
  // refetch. We don't merge in-place because the latest row by last_seen_at
  // is what the badge reads, and that ordering is server-side.
  useRealtimeStream(
    useMemo(
      () => [
        {
          table: "work_item_consumers",
          event: "*" as const,
          filter: "kind=eq.operator_dispatch",
          callback: () => {
            void refetch();
          },
        },
      ],
      [refetch],
    ),
  );

  return { consumer, freshness, isLoading, error };
}
