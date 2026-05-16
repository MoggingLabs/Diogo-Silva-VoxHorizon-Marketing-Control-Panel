"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * Audit page route-segment error boundary.
 *
 * Caught errors are typically Supabase fetch failures (network, bad token,
 * RLS surprises). Surfaces a "try again" button that resets the segment
 * via `reset()`. We deliberately don't auto-retry — the underlying issue
 * (e.g. expired secret) usually needs operator intervention.
 */
export default function AuditError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Audit page error:", error);
  }, [error]);

  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Audit</h1>

      <div
        role="alert"
        className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
      >
        <p className="font-semibold">Failed to load audit data.</p>
        <p className="text-destructive/90">
          {error.message || "An unexpected error occurred while loading the audit page."}
        </p>
        {error.digest ? (
          <p className="font-mono text-xs text-destructive/70">digest: {error.digest}</p>
        ) : null}
        <div>
          <Button variant="outline" onClick={() => reset()}>
            Try again
          </Button>
        </div>
      </div>
    </main>
  );
}
