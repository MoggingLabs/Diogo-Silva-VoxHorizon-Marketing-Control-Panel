import Link from "next/link";
import { notFound } from "next/navigation";

import { CancelPipelineButton } from "@/components/pipeline/CancelPipelineButton";
import { HorizontalStepper } from "@/components/pipeline/HorizontalStepper";
import { PipelineDetailRealtime } from "@/components/pipeline/PipelineDetailRealtime";
import { StageConfiguration } from "@/components/pipeline/StageConfiguration";
import { StageDone } from "@/components/pipeline/StageDone";
import { StageGeneration } from "@/components/pipeline/StageGeneration";
import { StageIdeation } from "@/components/pipeline/StageIdeation";
import { StagePlaceholder } from "@/components/pipeline/StagePlaceholder";
import { StageReview } from "@/components/pipeline/StageReview";
import { getPipeline } from "@/lib/pipeline/client";
import {
  PIPELINE_FORMAT_BADGE,
  PIPELINE_FORMAT_LABEL,
  PIPELINE_STAGES,
  PIPELINE_STATUS_BADGE,
  PIPELINE_STATUS_LABEL,
  type Pipeline,
  type PipelineEvent,
  type PipelineStatus,
} from "@/lib/pipeline/types";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Pipeline ${id.slice(0, 8)} — VoxHorizon` };
}

const STAGE_PLACEHOLDER_LABEL: Record<PipelineStatus, { label: string; wave: string }> = {
  configuration: { label: "Configuration", wave: "PF-B-X" },
  ideation: { label: "Ideation", wave: "PF-C-X" },
  review: { label: "Review", wave: "PF-D-X" },
  generation: { label: "Generation", wave: "PF-E-X" },
  done: { label: "Done", wave: "PF-F-X" },
  cancelled: { label: "Cancelled", wave: "PF-X-X" },
};

function shortClientLabel(p: Pipeline, clientName: string | null): string {
  if (clientName) return clientName;
  if (p.client_id) return p.client_id.slice(0, 8);
  return "Unassigned client";
}

export default async function PipelineDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let pipeline: Pipeline;
  let initialEvents: PipelineEvent[] = [];
  try {
    const res = await getPipeline(id);
    pipeline = res.pipeline;
    initialEvents = res.events ?? [];
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      notFound();
    }
    throw err;
  }

  let clientName: string | null = null;
  let clients: {
    id: string;
    name: string;
    slug: string;
    service_type: "roofing" | "remodeling";
  }[] = [];
  const supabase = await createClient();
  if (pipeline.client_id) {
    const { data } = await supabase
      .from("clients")
      .select("name")
      .eq("id", pipeline.client_id)
      .maybeSingle();
    clientName = data?.name ?? null;
  }
  // The StageConfiguration component needs a client list to populate the
  // picker. Server-fetching avoids the form's first paint flicker and keeps
  // the auth path consistent with the rest of the app.
  if (pipeline.status === "configuration") {
    const { data } = await supabase
      .from("clients")
      .select("id, name, slug, service_type")
      .eq("status", "active")
      .order("name");
    clients = (data ?? []) as typeof clients;
  }

  const placeholder = STAGE_PLACEHOLDER_LABEL[pipeline.status];
  const isCancellable = pipeline.status !== "done" && pipeline.status !== "cancelled";

  return (
    <main className="container mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <PipelineDetailRealtime pipelineId={pipeline.id} />

      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">
          <Link href="/pipeline" className="underline-offset-4 hover:underline">
            Pipeline
          </Link>{" "}
          / <span className="font-mono">{pipeline.id.slice(0, 8)}</span>
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl md:text-3xl">
              {shortClientLabel(pipeline, clientName)}
            </h1>
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs",
                PIPELINE_STATUS_BADGE[pipeline.status],
              )}
            >
              {PIPELINE_STATUS_LABEL[pipeline.status]}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs",
                PIPELINE_FORMAT_BADGE[pipeline.format_choice],
              )}
            >
              {PIPELINE_FORMAT_LABEL[pipeline.format_choice]}
            </span>
          </div>
          {isCancellable ? <CancelPipelineButton pipelineId={pipeline.id} /> : null}
        </div>
      </header>

      {pipeline.status === "cancelled" ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          This pipeline was cancelled. No further actions are available.
        </div>
      ) : (
        <section
          aria-label="Pipeline stages"
          className="rounded-lg border border-border bg-card px-4 py-4 sm:px-6 sm:py-5"
        >
          <HorizontalStepper stages={[...PIPELINE_STAGES]} current={pipeline.status} />
        </section>
      )}

      {pipeline.status === "configuration" ? (
        <StageConfiguration pipeline={pipeline} clients={clients} />
      ) : pipeline.status === "ideation" ? (
        <StageIdeation
          pipeline={pipeline}
          imageBriefId={pipeline.image_brief_id}
          videoBriefId={pipeline.video_brief_id}
        />
      ) : pipeline.status === "review" ? (
        <StageReview
          pipeline={pipeline}
          imageBriefId={pipeline.image_brief_id}
          videoBriefId={pipeline.video_brief_id}
        />
      ) : pipeline.status === "generation" ? (
        <StageGeneration pipeline={pipeline} initialEvents={initialEvents} />
      ) : pipeline.status === "done" ? (
        <StageDone
          pipeline={pipeline}
          imageBriefId={pipeline.image_brief_id}
          videoBriefId={pipeline.video_brief_id}
        />
      ) : (
        <StagePlaceholder
          stageLabel={placeholder.label}
          upcoming={placeholder.wave}
          subtitle={
            pipeline.status === "cancelled"
              ? "Cancelled pipelines do not advance further."
              : undefined
          }
        />
      )}
    </main>
  );
}
