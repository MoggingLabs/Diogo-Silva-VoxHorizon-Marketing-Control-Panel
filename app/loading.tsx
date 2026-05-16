/**
 * Root-level loading state. Rendered while a top-level server component is
 * still streaming. Matches the dashboard geometry (funnel header + kanban
 * tracks) so the swap to real content is visually low-jank.
 */
export default function DashboardLoading() {
  return (
    <div className="container mx-auto flex min-h-dvh flex-col gap-8 py-8" aria-busy="true">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-64 animate-pulse rounded-md bg-muted/70" />
        </div>
        <div className="h-9 w-40 animate-pulse rounded-md bg-muted" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-4"
          >
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="h-7 w-16 animate-pulse rounded bg-muted" />
            <div className="h-2 w-full animate-pulse rounded bg-muted/70" />
          </div>
        ))}
      </div>

      {Array.from({ length: 2 }).map((_, t) => (
        <div key={t} className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-muted" />
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          </div>
          <div className="flex gap-4 overflow-x-auto pb-2">
            {Array.from({ length: 5 }).map((_, c) => (
              <div
                key={c}
                className="flex w-[260px] shrink-0 flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3"
              >
                <div className="flex items-center justify-between">
                  <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                  <div className="h-4 w-8 animate-pulse rounded-full bg-muted" />
                </div>
                <div className="h-20 animate-pulse rounded-md bg-muted/70" />
                <div className="h-20 animate-pulse rounded-md bg-muted/70" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
