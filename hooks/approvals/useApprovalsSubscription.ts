"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Approval } from "@/lib/approvals/types";
import { createRealtimeQueue } from "@/lib/realtime-queue";
import { createClient as createBrowserClient } from "@/lib/supabase/browser";

/**
 * Live store of pending approvals.
 *
 * Behaviour:
 *  1. INSERT on `approvals` (status='pending') → push the row through the
 *     `onNewApproval` callback IMMEDIATELY so the modal can pop the moment
 *     the worker writes the row, then queue a debounced re-fetch so the
 *     list mirrors server state.
 *  2. UPDATE → fire `onApprovalResolved` when `new.status !== 'pending'`
 *     and queue the re-fetch.
 *  3. DELETE → queue the re-fetch (rare in production; rows are kept).
 *
 * The hook owns its Supabase channel + realtime queue and tears both down
 * on unmount. The `refresh` callback is exposed so callers can force a
 * re-fetch after their own POST.
 */
export type UseApprovalsSubscriptionOptions = {
  /** Fired the instant a brand-new pending approval lands. */
  onNewApproval?: (approval: Approval) => void;
  /** Fired when an approval transitions out of `pending` (decided / cancelled). */
  onApprovalResolved?: (approval: Approval) => void;
  /** Override the fetch URL — useful in tests. Defaults to `/api/approvals?status=pending`. */
  fetchUrl?: string;
};

export type UseApprovalsSubscriptionResult = {
  /** Current pending approvals, newest first (server-decided order). */
  approvals: Approval[];
  /** Pending count == approvals.length, exposed as its own field for clarity. */
  count: number;
  /** True before the first fetch completes. */
  loading: boolean;
  /** Last error message from the fetch, or null. */
  error: string | null;
  /** Manually re-fetch (e.g. after a decision was POSTed). */
  refresh: () => Promise<void>;
};

function isPendingApprovalShape(value: unknown): value is Approval {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && v.status === "pending";
}

export function useApprovalsSubscription(
  options: UseApprovalsSubscriptionOptions = {},
): UseApprovalsSubscriptionResult {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Hold the latest callbacks in a ref so the effect only re-runs on
  // `fetchUrl` change.
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  const fetchUrl = options.fetchUrl ?? "/api/approvals?status=pending";

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(fetchUrl, { cache: "no-store" });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { approvals?: Approval[] };
      setApprovals(body.approvals ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [fetchUrl]);

  useEffect(() => {
    void refresh();
    const supabase = createBrowserClient();
    const queue = createRealtimeQueue();

    const channel = supabase
      .channel("approvals-pending")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "approvals" },
        (payload) => {
          const row = payload.new as unknown;
          if (isPendingApprovalShape(row)) {
            callbacksRef.current.onNewApproval?.(row);
          }
          queue.queue("refresh", () => {
            void refresh();
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "approvals" },
        (payload) => {
          const row = payload.new as unknown;
          if (row && typeof row === "object") {
            const v = row as Record<string, unknown>;
            if (v.status !== "pending" && typeof v.id === "string") {
              callbacksRef.current.onApprovalResolved?.(row as Approval);
            }
          }
          queue.queue("refresh", () => {
            void refresh();
          });
        },
      )
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "approvals" }, () => {
        queue.queue("refresh", () => {
          void refresh();
        });
      })
      .subscribe();

    return () => {
      queue.dispose();
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  return {
    approvals,
    count: approvals.length,
    loading,
    error,
    refresh,
  };
}
