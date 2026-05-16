/**
 * Skeleton for the `/briefs` index. Mirrors the grouped-status-table layout
 * so swap-in is low-jank.
 */
export default function BriefsListLoading() {
  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 py-12" aria-busy="true">
      <header className="flex items-center justify-between">
        <div className="h-9 w-32 animate-pulse rounded-md bg-muted" />
        <div className="h-10 w-28 animate-pulse rounded-md bg-muted" />
      </header>

      <div className="space-y-8">
        {Array.from({ length: 2 }).map((_, section) => (
          <section key={section} className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="h-5 w-28 animate-pulse rounded bg-muted" />
              <div className="h-3 w-8 animate-pulse rounded bg-muted/70" />
            </div>
            <div className="overflow-hidden rounded-md border">
              <div className="border-b bg-muted/50 px-3 py-2">
                <div className="h-3 w-32 animate-pulse rounded bg-muted" />
              </div>
              {Array.from({ length: 3 }).map((_, row) => (
                <div key={row} className="flex items-center gap-4 border-t px-3 py-3">
                  <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-24 animate-pulse rounded bg-muted/70" />
                  <div className="h-3 w-16 animate-pulse rounded bg-muted/70" />
                  <div className="h-3 w-12 animate-pulse rounded bg-muted/70" />
                  <div className="ml-auto h-5 w-16 animate-pulse rounded-full bg-muted" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
