"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * Error boundary for `/creatives/video/[briefId]`. Recovers via the Next.js
 * `reset` callback when the operator clicks "Try again". We don't ship the
 * raw error message into the UI to avoid leaking server-side context;
 * `digest` is shown for log correlation.
 */
export default function CreativesVideoError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the console so the operator can copy if needed.
    console.error("[creatives/video] page error:", error);
  }, [error]);

  return (
    <main className="container mx-auto flex min-h-dvh max-w-6xl flex-col items-start gap-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Couldn&apos;t load video creatives</h1>
      <p className="text-sm text-muted-foreground">
        Something went wrong while fetching this brief&apos;s video variants.
      </p>
      {error.digest ? (
        <p className="font-mono text-[11px] text-muted-foreground">digest: {error.digest}</p>
      ) : null}
      <Button type="button" onClick={() => reset()}>
        Try again
      </Button>
    </main>
  );
}
