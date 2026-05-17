/**
 * Skeleton placeholder while the video launch detail page is fetching.
 */
export default function VideoLaunchDetailLoading() {
  return (
    <main className="container mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <header className="space-y-3">
        <div className="h-3 w-40 rounded bg-muted" />
        <div className="h-8 w-72 rounded bg-muted" />
      </header>

      <div className="space-y-4 rounded-md border bg-card p-4 shadow-sm">
        <div className="h-5 w-40 rounded bg-muted" />
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-4 w-full rounded bg-muted/60" />
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-md border bg-card p-4 shadow-sm">
            <div className="aspect-video w-full rounded bg-muted" />
            <div className="h-4 w-3/4 rounded bg-muted/60" />
            <div className="h-3 w-1/2 rounded bg-muted/40" />
          </div>
        ))}
      </div>
    </main>
  );
}
