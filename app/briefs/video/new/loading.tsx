/**
 * Skeleton for the new-video-brief composer. Approximates the form geometry.
 */
export default function NewVideoBriefLoading() {
  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 py-12" aria-busy="true">
      <header className="flex items-center justify-between">
        <div className="flex flex-col gap-2">
          <div className="h-9 w-64 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-80 animate-pulse rounded-md bg-muted/70" />
        </div>
        <div className="h-4 w-32 animate-pulse rounded-md bg-muted/70" />
      </header>

      <div className="flex flex-col gap-5 rounded-md border bg-background p-5">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="h-3 w-32 animate-pulse rounded bg-muted/70" />
            <div className="h-10 w-full animate-pulse rounded-md bg-muted/40" />
          </div>
        ))}
        <div className="flex gap-2 pt-2">
          <div className="h-10 w-32 animate-pulse rounded-md bg-muted" />
          <div className="h-10 w-40 animate-pulse rounded-md bg-muted/60" />
        </div>
      </div>
    </main>
  );
}
