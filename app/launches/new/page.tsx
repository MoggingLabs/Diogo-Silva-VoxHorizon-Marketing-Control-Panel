import Link from "next/link";
import { notFound } from "next/navigation";

import {
  LaunchBuilderForm,
  type LaunchBuilderPrefill,
} from "@/components/launch/LaunchBuilderForm";
import type { Brief } from "@/lib/briefs";
import type { Creative } from "@/lib/creatives";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata = { title: "Build launch package — VoxHorizon" };

type SearchParams = Promise<{ pipeline_id?: string }>;

/**
 * Server entry-point for the launch builder.
 *
 * Two modes, distinguished by the optional ``?pipeline_id=`` search param:
 *
 *  - **No pipeline id** → render a launch-from-scratch form. The operator
 *    picks an approved brief from a dropdown and submits; the API does the
 *    bundling. This is the existing today's flow surfaced as a real page.
 *
 *  - **Pipeline id present** → fetch the pipeline + its final creatives so
 *    we can hand the form a fully-prefilled snapshot: brief reference,
 *    attached creatives, budget hint pulled from the pipeline's
 *    ``config_draft``. The operator can still edit/remove pieces before
 *    submitting — the form fields stay live.
 *
 * The form itself is a client component; this page exists only to do the
 * server-side data load. Keeps the boundary clean and lets the data fetch
 * benefit from RLS without an extra round-trip.
 */
export default async function LaunchesNewPage({ searchParams }: { searchParams: SearchParams }) {
  const { pipeline_id } = await searchParams;
  const supabase = await createClient();

  // Fast path: no pipeline handoff. Render a minimal "pick a brief" form.
  if (!pipeline_id) {
    const { data: briefs, error: briefsErr } = await supabase
      .from("briefs")
      .select("id, brief_id_human, status, client_id, clients(name)")
      .in("status", ["approved", "approved_with_changes"])
      .order("created_at", { ascending: false })
      .limit(100);
    if (briefsErr) {
      throw new Error(briefsErr.message);
    }
    const eligibleBriefs = (briefs ?? []).map((b) => ({
      id: b.id,
      brief_id_human: b.brief_id_human,
      client_name: b.clients?.name ?? null,
    }));

    return (
      <main className="container mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
        <header className="space-y-2">
          <p className="text-sm text-muted-foreground">
            <Link href="/launches" className="underline-offset-4 hover:underline">
              Launches
            </Link>{" "}
            / New
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Build a launch package
          </h1>
          <p className="text-sm text-muted-foreground">
            Pick an approved brief to bundle creatives + copy + targeting into a launch package.
          </p>
        </header>
        <LaunchBuilderForm mode="scratch" eligibleBriefs={eligibleBriefs} />
      </main>
    );
  }

  // Pipeline-handoff path. Fetch the pipeline row + its final image
  // creatives. We use the public Supabase client (server-side) so RLS
  // applies — operators authed via the same session can read the pipeline
  // and its creatives without needing the admin key here.
  // Silent-failure PR-4: `pipelines.status` was dropped (migration 0051).
  // This page only uses the row's brief / config / launch metadata, never
  // the status, so we just drop the field from the select list.
  const { data: pipelineRow, error: pipelineErr } = await supabase
    .from("pipelines")
    .select("id, format_choice, image_brief_id, video_brief_id, config_draft, launch_package_id")
    .eq("id", pipeline_id)
    .maybeSingle();
  if (pipelineErr) {
    throw new Error(pipelineErr.message);
  }
  if (!pipelineRow) notFound();

  // The brief reference is whichever image brief the pipeline owns; the
  // image launch package shape doesn't bundle video creatives in v1, so
  // a pure-video pipeline can't be turned into an image launch. Surface
  // that as a graceful empty state rather than 404.
  let brief: Pick<Brief, "id" | "brief_id_human"> | null = null;
  let creatives: Creative[] = [];
  if (pipelineRow.image_brief_id) {
    const [briefRes, creativesRes] = await Promise.all([
      supabase
        .from("briefs")
        .select("id, brief_id_human, status, clients(name)")
        .eq("id", pipelineRow.image_brief_id)
        .maybeSingle(),
      supabase
        .from("creatives")
        .select(
          "id, brief_id, concept, ratio, version, status, file_path_drive, file_path_supabase",
        )
        .eq("brief_id", pipelineRow.image_brief_id)
        .neq("version", "v0.ideation"),
    ]);
    if (briefRes.error) throw new Error(briefRes.error.message);
    if (creativesRes.error) throw new Error(creativesRes.error.message);
    brief = briefRes.data
      ? { id: briefRes.data.id, brief_id_human: briefRes.data.brief_id_human }
      : null;
    creatives = (creativesRes.data ?? []) as unknown as Creative[];
  }

  // Pull the budget hint out of `config_draft.budget` if the operator set
  // one during the configuration stage. The exact shape is jsonb-soft
  // (StageConfiguration evolves it across waves), so we cast carefully.
  const configDraft = pipelineRow.config_draft as { budget?: number } | null;
  const budgetHint = typeof configDraft?.budget === "number" ? configDraft.budget : null;

  const prefill: LaunchBuilderPrefill = {
    pipeline_id: pipelineRow.id,
    brief,
    creatives,
    budget_hint: budgetHint,
  };

  // If the pipeline already has a linked launch, push the operator at the
  // existing one instead of letting them double-build. The 422 from the
  // API would catch it too — this is purely a UX guardrail.
  if (pipelineRow.launch_package_id) {
    return (
      <main className="container mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Launch already built
          </h1>
          <p className="text-sm text-muted-foreground">
            This pipeline is already linked to a launch package.
          </p>
        </header>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/launches/${pipelineRow.launch_package_id}`}
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            View launch package
          </Link>
          <Link
            href={`/pipeline/${pipelineRow.id}`}
            className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted"
          >
            Back to pipeline
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="container mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">
          <Link href={`/pipeline/${pipelineRow.id}`} className="underline-offset-4 hover:underline">
            Pipeline {pipelineRow.id.slice(0, 8)}
          </Link>{" "}
          / Build launch
        </p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Build a launch package
        </h1>
      </header>

      <section
        className="rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900"
        role="status"
      >
        Building launch package from pipeline{" "}
        <span className="font-mono">{pipelineRow.id.slice(0, 8)}</span>. The finals below are
        prefilled — you can still trim before submitting.
      </section>

      <LaunchBuilderForm mode="pipeline" prefill={prefill} />
    </main>
  );
}
