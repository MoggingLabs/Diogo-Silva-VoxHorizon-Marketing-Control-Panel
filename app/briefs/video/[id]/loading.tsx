/**
 * Skeleton for a single video brief detail page. Approximates the
 * header / two-column outline + timeline layout.
 */
export default function VideoBriefDetailLoading() {
  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-8 py-12" aria-busy="true">
      <header className="flex flex-col gap-2">
        <div className="h-3 w-32 animate-pulse rounded bg-muted/70" />
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="h-8 w-56 animate-pulse rounded bg-muted" />
          <div className="h-6 w-20 animate-pulse rounded-full bg-muted" />
        </div>
        <div className="h-4 w-80 animate-pulse rounded bg-muted/70" />
      </header>

      <div className="grid gap-8 lg:grid-cols-3">
        <section className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-md border border-input bg-background p-4">
            <div className="h-5 w-32 animate-pulse rounded bg-muted" />
            <div className="mt-3 flex flex-col gap-4">
              <div className="space-y-2">
                <div className="h-2 w-12 animate-pulse rounded bg-muted/70" />
                <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
              </div>
              <div className="space-y-2">
                <div className="h-2 w-24 animate-pulse rounded bg-muted/70" />
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-14 w-full animate-pulse rounded-sm border border-input/60 bg-muted/30"
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-md border border-input bg-background p-4">
            <div className="h-5 w-16 animate-pulse rounded bg-muted" />
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-4 w-24 animate-pulse rounded bg-muted/70" />
              ))}
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="h-5 w-24 animate-pulse rounded bg-muted" />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 w-full animate-pulse rounded-md border bg-muted/20" />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
