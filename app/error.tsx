"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Root error boundary. Catches anything thrown from the root layout or page
 * that wasn't handled by a more specific `app/<route>/error.tsx`.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("RootError", error);
  }, [error]);

  return (
    <div className="container mx-auto flex min-h-dvh max-w-2xl flex-col items-start gap-4 py-16">
      <div className="flex items-center gap-2 text-destructive">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        <h2 className="text-2xl font-semibold">Something went wrong</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        We hit an unexpected error while loading this page. The team has been notified.
      </p>
      {error.message ? (
        <p className="break-words rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      {error.digest ? (
        <p className="font-mono text-xs text-muted-foreground">ref: {error.digest}</p>
      ) : null}
      <Button onClick={() => reset()}>Retry</Button>
    </div>
  );
}
