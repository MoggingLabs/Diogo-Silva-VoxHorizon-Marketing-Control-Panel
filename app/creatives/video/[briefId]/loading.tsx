/**
 * Skeleton for `/creatives/video/[briefId]`. Mirrors the page header
 * + grid layout so the transition is visually steady while the server
 * resolves the brief, creatives, and signed URLs.
 */
export default function Loading() {
  return (
    <main className="container mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <header className="space-y-3">
        <div className="h-4 w-44 animate-pulse rounded bg-muted/60" />
        <div className="flex flex-wrap items-center gap-3">
          <div className="h-7 w-72 animate-pulse rounded bg-muted/60" />
          <div className="h-5 w-24 animate-pulse rounded-full bg-muted/60" />
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="h-2 w-16 animate-pulse rounded bg-muted/60" />
              <div className="h-3 w-24 animate-pulse rounded bg-muted/60" />
            </div>
          ))}
        </div>
      </header>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 overflow-hidden rounded-md border bg-card">
            <div className="aspect-square w-full animate-pulse bg-muted/60" />
            <div className="space-y-1.5 px-3 pb-3 pt-1">
              <div className="h-4 w-3/4 animate-pulse rounded bg-muted/60" />
              <div className="flex justify-between gap-2">
                <div className="h-3 w-12 animate-pulse rounded bg-muted/60" />
                <div className="h-3 w-14 animate-pulse rounded bg-muted/60" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
