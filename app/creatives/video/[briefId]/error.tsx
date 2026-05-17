"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Error boundary for `/creatives/video/[briefId]`. Mirrors the image-side
 * error layout (`/creatives/[briefId]/error.tsx`): icon + breadcrumb back
 * to video briefs, the error message in a styled box, and retry / back
 * actions. Recovers via the Next.js `reset` callback when the operator
 * clicks "Retry".
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
    <main className="container mx-auto flex min-h-dvh max-w-2xl flex-col items-start gap-4 px-4 py-6 sm:px-6 sm:py-12">
      <p className="text-sm text-muted-foreground">
        <Link href="/briefs/video" className="underline-offset-4 hover:underline">
          Video briefs
        </Link>{" "}
        / Video creatives
      </p>
      <div className="flex items-center gap-2 text-destructive">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        <h2 className="text-2xl font-semibold">Couldn&apos;t load video creatives</h2>
      </div>
      {error.message ? (
        <p className="break-words rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      {error.digest ? (
        <p className="font-mono text-xs text-muted-foreground">ref: {error.digest}</p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button onClick={() => reset()} className="min-h-11">
          Retry
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link href="/briefs/video">Back to video briefs</Link>
        </Button>
      </div>
    </main>
  );
}
