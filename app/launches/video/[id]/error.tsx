"use client";

import { useEffect } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Error boundary for the video launch detail page. Mirrors the image-side
 * `/launches/[id]/error.tsx` layout. Adds a "Back to video launches" link
 * so the operator never gets stuck if the retry keeps failing.
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
    <main className="container mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
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
        <p className="break-words font-medium">{error.message || "Unknown error"}</p>
        {error.digest ? (
          <p className="mt-1 font-mono text-xs opacity-70">digest: {error.digest}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" onClick={reset} className="min-h-11">
          Try again
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link href="/launches/video">Back to video launches</Link>
        </Button>
      </div>
    </main>
  );
}
