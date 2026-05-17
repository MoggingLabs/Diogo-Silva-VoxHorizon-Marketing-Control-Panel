import { FormatToggle } from "@/components/funnel/FormatToggle";
import { FunnelHeader } from "@/components/funnel/FunnelHeader";
import { KanbanBoard, type BriefPipelineMap } from "@/components/kanban/KanbanBoard";
import { getDashboardSnapshot, parseFormat } from "@/lib/dashboard";
import { findPipelinesForBriefs } from "@/lib/pipeline/lookup";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Dashboard — VoxHorizon",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Unified dashboard: funnel-header KPIs + stacked bar on top, Kanban board
 * (one or two tracks depending on the format toggle) below. Server-rendered
 * so the first paint is data-complete; the inner `<KanbanBoard />` is a
 * client component that subscribes to Realtime and calls `router.refresh()`
 * on any brief / video_brief mutation.
 */
export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const rawFormat = Array.isArray(params.format) ? params.format[0] : params.format;
  const format = parseFormat(rawFormat);

  const snapshot = await getDashboardSnapshot(format);
  const errorMessages = [snapshot.errors.image, snapshot.errors.video].filter(
    (m): m is string => typeof m === "string" && m.length > 0,
  );

  // Pipeline-aware deep-link map: one DB round-trip across both brief lists,
  // populating which cards should jump into the Pipeline detail view instead
  // of the standalone brief page (#177). Empty maps are fine — KanbanCard
  // falls back to the standalone link when the lookup misses.
  const pipelineLookup = await findPipelinesForBriefs(
    snapshot.image_briefs.map((b) => b.id),
    snapshot.video_briefs.map((b) => b.id),
  );
  const imagePipelineMap: BriefPipelineMap = Object.fromEntries(pipelineLookup.image);
  const videoPipelineMap: BriefPipelineMap = Object.fromEntries(pipelineLookup.video);

  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Dashboard</h1>
          <p className="text-sm text-muted-foreground">VoxHorizon Marketing Control Panel</p>
        </div>
        <FormatToggle value={format} />
      </header>

      {errorMessages.length > 0 ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {errorMessages.length === 1
            ? `Failed to load dashboard data: ${errorMessages[0]}`
            : `Failed to load dashboard data: ${errorMessages.join("; ")}`}
        </div>
      ) : null}

      <FunnelHeader format={format} counts={snapshot.counts} />

      <KanbanBoard
        format={format}
        imageBriefs={snapshot.image_briefs}
        videoBriefs={snapshot.video_briefs}
        imagePipelineMap={imagePipelineMap}
        videoPipelineMap={videoPipelineMap}
      />
    </main>
  );
}
