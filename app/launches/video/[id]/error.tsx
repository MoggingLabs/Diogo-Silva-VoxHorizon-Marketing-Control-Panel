"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * Error boundary for the video launch detail page.
 */
export default function VideoLaunchDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[video launch detail]", error);
  }, [error]);

  return (
    <main className="container mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 py-12">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Failed to load video launch</h1>
        <p className="text-sm text-muted-foreground">
          Something went wrong rendering this video launch package.
        </p>
      </header>

      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
      >
        <p className="font-medium">{error.message || "Unknown error"}</p>
        {error.digest ? (
          <p className="mt-1 font-mono text-xs opacity-70">digest: {error.digest}</p>
        ) : null}
      </div>

      <div className="flex gap-2">
        <Button type="button" onClick={reset}>
          Try again
        </Button>
      </div>
    </main>
  );
}
