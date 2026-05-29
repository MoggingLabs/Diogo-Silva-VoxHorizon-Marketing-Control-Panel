import Link from "next/link";
import type { Route } from "next";
import { Bot } from "lucide-react";

import { Button } from "@/components/ui/button";
import { listPipelinesQuery } from "@/lib/pipeline/queries";
import { PipelineList } from "@/components/pipeline/PipelineList";
import { createClient } from "@/lib/supabase/server";
import type { Pipeline } from "@/lib/pipeline/types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Pipeline — VoxHorizon",
};

/**
 * Pipeline index. Lists every pipeline ordered by `updated_at desc` and
 * groups them under filter chips. The list itself lives in the client
 * component so we can subscribe to realtime updates.
 *
 * Client names are resolved server-side so the UI can show a friendly
 * label instead of a UUID. We bypass the API for that lookup because the
 * `clients` table is owned by the same app and RLS already restricts the
 * row set.
 */
export default async function PipelineIndexPage() {
  let pipelines: Pipeline[] = [];
  let loadError: string | null = null;

  try {
    const res = await listPipelinesQuery({ limit: 200 });
    pipelines = res.pipelines;
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Failed to load pipelines.";
  }

  const clientIds = Array.from(
    new Set(pipelines.map((p) => p.client_id).filter((id): id is string => !!id)),
  );

  const clientNames: Record<string, string> = {};
  if (clientIds.length > 0) {
    const supabase = await createClient();
    const { data } = await supabase.from("clients").select("id,name").in("id", clientIds);
    for (const row of data ?? []) {
      clientNames[row.id] = row.name;
    }
  }

  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            Walk a brief through configuration, ideation, review, generation, and launch.
          </p>
        </div>
        <Button asChild className="gap-2 sm:self-start">
          <Link href={"/pipeline/operator" as Route}>
            <Bot className="h-4 w-4" aria-hidden="true" />
            Hire the operator
          </Link>
        </Button>
      </header>

      {loadError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Failed to load pipelines: {loadError}
        </div>
      ) : null}

      <PipelineList initialPipelines={pipelines} clientNames={clientNames} />
    </main>
  );
}
