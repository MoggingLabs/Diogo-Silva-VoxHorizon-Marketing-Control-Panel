import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { createPipeline } from "@/lib/pipeline/client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "New pipeline — VoxHorizon",
};

/**
 * Kickoff route. Calls `POST /api/pipelines` with the default image format
 * choice, then redirects to the freshly-minted pipeline's detail page.
 *
 * We do this in a Server Component (not a Server Action) so a plain GET
 * navigation to `/pipeline/new` is enough to start a pipeline — keeps the
 * "Start new pipeline" button a single hyperlink with no client-side
 * trampoline. On failure we render an inline retry UI instead of redirecting.
 */
export default async function NewPipelinePage() {
  let createError: string | null = null;
  let newId: string | null = null;

  try {
    const pipeline = await createPipeline({ format_choice: "image" });
    newId = pipeline.id;
  } catch (err) {
    createError = err instanceof Error ? err.message : "Failed to start pipeline.";
  }

  if (newId) {
    redirect(`/pipeline/${newId}`);
  }

  return (
    <main className="container mx-auto flex min-h-dvh max-w-2xl flex-col items-start gap-4 px-4 py-12 sm:px-6">
      <p className="text-sm text-muted-foreground">
        <Link href="/pipeline" className="underline-offset-4 hover:underline">
          Pipeline
        </Link>{" "}
        / new
      </p>
      <div className="flex items-center gap-2 text-destructive">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        <h1 className="text-2xl font-semibold">Couldn&apos;t start a new pipeline</h1>
      </div>
      {createError ? (
        <p className="break-words rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {createError}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button asChild>
          <Link href="/pipeline/new">Try again</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/pipeline">Back to pipeline</Link>
        </Button>
      </div>
    </main>
  );
}
