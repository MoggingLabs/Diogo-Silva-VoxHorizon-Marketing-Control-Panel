import { FormatToggle } from "@/components/funnel/FormatToggle";
import { FunnelHeader } from "@/components/funnel/FunnelHeader";
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { getDashboardSnapshot, parseFormat } from "@/lib/dashboard";

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

  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-8 py-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
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
      />
    </main>
  );
}
