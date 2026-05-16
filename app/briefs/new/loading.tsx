/**
 * Skeleton for the new-image-brief composer. Approximates the form geometry
 * (label + field rows + submit) so swap-in is low-jank.
 */
export default function NewBriefLoading() {
  return (
    <main
      className="container mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 py-12"
      aria-busy="true"
    >
      <header className="space-y-2">
        <div className="h-3 w-28 animate-pulse rounded bg-muted/70" />
        <div className="h-9 w-64 animate-pulse rounded bg-muted" />
      </header>
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted/70" />

      <div className="flex flex-col gap-5 rounded-md border bg-background p-5">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="h-3 w-24 animate-pulse rounded bg-muted/70" />
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
