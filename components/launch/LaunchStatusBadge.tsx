"use client";

import * as React from "react";

/**
 * Shared launch status type. The image (`launch_packages`) and video
 * (`video_launch_packages`) lifecycles use the same six-state enum, so the
 * badge + the optimistic-status context can be shared across both detail
 * pages.
 */
export type LaunchStatusValue =
  | "validating"
  | "posted"
  | "approved"
  | "approved_with_changes"
  | "rejected"
  | "failed";

const STATUS_LABEL: Record<LaunchStatusValue, string> = {
  validating: "Validating",
  posted: "Posted",
  approved: "Approved",
  approved_with_changes: "Approved with changes",
  rejected: "Rejected",
  failed: "Failed",
};

const STATUS_BADGE: Record<LaunchStatusValue, string> = {
  validating: "bg-zinc-100 text-zinc-700",
  posted: "bg-amber-100 text-amber-900",
  approved: "bg-emerald-100 text-emerald-900",
  approved_with_changes: "bg-sky-100 text-sky-900",
  rejected: "bg-destructive/10 text-destructive",
  failed: "bg-rose-100 text-rose-800",
};

export function launchStatusLabel(status: string): string {
  return STATUS_LABEL[status as LaunchStatusValue] ?? status;
}

interface LaunchStatusContextValue {
  /** The status currently shown by the badge: optimistic if set, else server. */
  status: LaunchStatusValue;
  /**
   * Push an optimistic status (e.g. from a successful decision POST) so the
   * badge flips immediately, without waiting on the slow ``router.refresh()``
   * re-render of the Supabase-heavy detail page.
   */
  setOptimisticStatus: (next: LaunchStatusValue) => void;
}

const LaunchStatusContext = React.createContext<LaunchStatusContextValue | null>(null);

/**
 * Provides the shared optimistic launch status to the badge + the approval
 * gate. Seeded from the server-rendered status; the gate overwrites it on a
 * successful decision so the badge flips synchronously. Keyed on
 * ``serverStatus`` by the caller so a later authoritative server re-render
 * re-seeds the provider.
 */
export function LaunchStatusProvider({
  serverStatus,
  children,
}: {
  serverStatus: string;
  children: React.ReactNode;
}) {
  const initial = (
    STATUS_LABEL[serverStatus as LaunchStatusValue] ? (serverStatus as LaunchStatusValue) : "posted"
  ) as LaunchStatusValue;
  const [optimistic, setOptimistic] = React.useState<LaunchStatusValue | null>(null);

  const value = React.useMemo<LaunchStatusContextValue>(
    () => ({
      status: optimistic ?? initial,
      setOptimisticStatus: setOptimistic,
    }),
    [optimistic, initial],
  );

  return <LaunchStatusContext.Provider value={value}>{children}</LaunchStatusContext.Provider>;
}

/**
 * Read the shared launch-status context. Returns ``null`` when rendered
 * outside a provider so callers can no-op gracefully.
 */
export function useLaunchStatus(): LaunchStatusContextValue | null {
  return React.useContext(LaunchStatusContext);
}

/**
 * The header status pill. Renders from the shared optimistic status when a
 * provider is present (so it flips the instant a decision POST succeeds), and
 * falls back to the server-rendered ``status`` prop otherwise.
 */
export function LaunchStatusBadge({ status }: { status: string }) {
  const ctx = useLaunchStatus();
  const current = ctx ? ctx.status : ((status as LaunchStatusValue) ?? "posted");
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs ${
        STATUS_BADGE[current] ?? STATUS_BADGE.posted
      }`}
    >
      {STATUS_LABEL[current] ?? current}
    </span>
  );
}
