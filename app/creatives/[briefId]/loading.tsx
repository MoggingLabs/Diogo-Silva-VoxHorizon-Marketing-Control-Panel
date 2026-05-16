/**
 * Skeleton for the variants grid page. Mirrors the header + 4-col grid.
 */
export default function CreativesLoading() {
  return (
    <main
      className="container mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 py-10"
      aria-busy="true"
    >
      <header className="space-y-3">
        <div className="h-3 w-48 animate-pulse rounded bg-muted/70" />
        <div className="flex flex-wrap items-center gap-3">
          <div className="h-7 w-48 animate-pulse rounded bg-muted" />
          <div className="h-5 w-24 animate-pulse rounded-full bg-muted" />
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-3 w-24 animate-pulse rounded bg-muted/70" />
          ))}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-md border border-input bg-background p-3"
          >
            <div className="aspect-square w-full animate-pulse rounded-md bg-muted" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-muted/70" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted/70" />
          </div>
        ))}
      </div>
    </main>
  );
}
