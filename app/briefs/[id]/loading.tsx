/**
 * Skeleton for a single brief detail page. Tracks the header + key-value
 * grid + sections layout.
 */
export default function BriefDetailLoading() {
  return (
    <main
      className="container mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 py-12"
      aria-busy="true"
    >
      <header className="space-y-2">
        <div className="h-3 w-40 animate-pulse rounded bg-muted/70" />
        <div className="flex flex-wrap items-center gap-3">
          <div className="h-8 w-56 animate-pulse rounded bg-muted" />
          <div className="h-5 w-20 animate-pulse rounded-full bg-muted" />
        </div>
      </header>

      <section className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1">
            <div className="h-2 w-16 animate-pulse rounded bg-muted/70" />
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <div className="h-5 w-24 animate-pulse rounded bg-muted" />
        <div className="space-y-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-3 w-3/4 animate-pulse rounded bg-muted/70" />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="h-5 w-24 animate-pulse rounded bg-muted" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 w-full animate-pulse rounded-md border bg-muted/30" />
          ))}
        </div>
      </section>
    </main>
  );
}
