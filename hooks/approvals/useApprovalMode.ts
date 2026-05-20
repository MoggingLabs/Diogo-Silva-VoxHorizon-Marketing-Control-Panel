"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ApprovalModeState } from "@/lib/approval-mode/types";
import { createRealtimeQueue } from "@/lib/realtime-queue";
import { useRealtimeStream } from "@/hooks/useRealtimeStream";

/**
 * Live store of the current operator-controlled approval mode.
 *
 * Behaviour:
 *  - Initial fetch from ``/api/approval-mode`` on mount.
 *  - Subscribes to the ``approval_mode`` Realtime publication (added in
 *    migration 0009) for INSERT / UPDATE / DELETE — any event triggers a
 *    debounced re-fetch so the row stays current.
 *  - Exposes ``refresh`` for caller-triggered re-fetches (e.g. after a
 *    successful PUT from the Settings page).
 *
 * Failure semantics: a fetch failure surfaces via ``error`` but does NOT
 * tear down the subscription — the user can retry by leaving + returning
 * to the page, and the realtime channel will push the next change.
 */
export type UseApprovalModeOptions = {
  /** Override the fetch URL — useful in tests. */
  fetchUrl?: string;
};

export type UseApprovalModeResult = {
  /** The latest known mode state, or ``null`` while loading. */
  state: ApprovalModeState | null;
  /** True before the first fetch completes. */
  loading: boolean;
  /** Last error message from the fetch, or null. */
  error: string | null;
  /** Re-fetch on demand (after a save). */
  refresh: () => Promise<void>;
};

export function useApprovalMode(options: UseApprovalModeOptions = {}): UseApprovalModeResult {
  const [state, setState] = useState<ApprovalModeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Hold the latest fetchUrl in a ref so the effect's identity stays
  // stable across renders.
  const fetchUrlRef = useRef(options.fetchUrl ?? "/api/approval-mode");
  fetchUrlRef.current = options.fetchUrl ?? "/api/approval-mode";

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(fetchUrlRef.current, { cache: "no-store" });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        setLoading(false);
        return;
      }
      const body = (await res.json()) as ApprovalModeState;
      setState(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + the 30s "remaining TTL" countdown tick. Realtime fires on
  // row changes, not on TTL ticks, so we still swap the state object identity
  // on an interval so countdown components re-render without a round-trip.
  useEffect(() => {
    void refresh();
    const tick = setInterval(() => {
      setState((cur) => (cur ? { ...cur } : cur));
    }, 30_000);
    return () => clearInterval(tick);
  }, [refresh]);

  // Realtime now flows through the server-side SSE relay; any approval_mode
  // change triggers a debounced re-fetch.
  const queueRef = useRef(createRealtimeQueue());
  useEffect(() => {
    const queue = queueRef.current;
    return () => queue.dispose();
  }, []);

  useRealtimeStream(
    useMemo(
      () => [
        {
          table: "approval_mode",
          event: "*" as const,
          callback: () => {
            queueRef.current.queue("refresh", () => {
              void refresh();
            });
          },
        },
      ],
      [refresh],
    ),
  );

  return { state, loading, error, refresh };
}
