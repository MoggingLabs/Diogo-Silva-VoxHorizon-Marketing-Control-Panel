"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function PipelineDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("PipelineDetailError", error);
  }, [error]);

  return (
    <main className="container mx-auto flex min-h-dvh max-w-2xl flex-col items-start gap-4 px-4 py-12 sm:px-6">
      <p className="text-sm text-muted-foreground">
        <Link href="/pipeline" className="underline-offset-4 hover:underline">
          Pipeline
        </Link>{" "}
        / error
      </p>
      <div className="flex items-center gap-2 text-destructive">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        <h2 className="text-2xl font-semibold">Couldn&apos;t load this pipeline</h2>
      </div>
      {error.message ? (
        <p className="break-words rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      {error.digest ? (
        <p className="font-mono text-xs text-muted-foreground">ref: {error.digest}</p>
      ) : null}
      <div className="flex gap-2">
        <Button onClick={() => reset()}>Retry</Button>
        <Button asChild variant="outline">
          <Link href="/pipeline">Back to pipeline</Link>
        </Button>
      </div>
    </main>
  );
}
