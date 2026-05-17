/**
 * Skeleton for a pipeline detail page. Tracks the header + stepper + stage
 * card layout so the shimmer doesn't reshuffle when the real content lands.
 */
export default function PipelineDetailLoading() {
  return (
    <main
      className="container mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12"
      aria-busy="true"
    >
      <header className="space-y-2">
        <div className="h-3 w-40 animate-pulse rounded bg-muted/70" />
        <div className="flex flex-wrap items-center gap-3">
          <div className="h-8 w-56 animate-pulse rounded bg-muted" />
          <div className="h-5 w-20 animate-pulse rounded-full bg-muted" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
        </div>
      </header>

      <section
        aria-hidden="true"
        className="rounded-lg border border-border bg-card px-4 py-5 opacity-60"
      >
        <div className="flex items-center gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex flex-1 items-center gap-2">
              <div className="h-9 w-9 animate-pulse rounded-full bg-muted" />
              {i < 4 ? <div className="h-0.5 flex-1 animate-pulse rounded bg-muted/70" /> : null}
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-3 flex-1 animate-pulse rounded bg-muted/60" />
          ))}
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-border bg-card p-5 sm:p-6">
        <div className="space-y-2">
          <div className="h-5 w-48 animate-pulse rounded bg-muted" />
          <div className="h-3 w-72 animate-pulse rounded bg-muted/70" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 w-full animate-pulse rounded-md border bg-muted/30" />
          ))}
        </div>
        <div className="flex justify-end">
          <div className="h-10 w-32 animate-pulse rounded-md bg-muted" />
        </div>
      </section>
    </main>
  );
}
