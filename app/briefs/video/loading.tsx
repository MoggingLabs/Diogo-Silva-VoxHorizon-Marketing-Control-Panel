/**
 * Skeleton for the `/briefs/video` index. Approximates the list-row layout.
 */
export default function VideoBriefsLoading() {
  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 py-12" aria-busy="true">
      <header className="flex items-center justify-between">
        <div className="flex flex-col gap-2">
          <div className="h-9 w-48 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-60 animate-pulse rounded-md bg-muted/70" />
        </div>
        <div className="h-10 w-40 animate-pulse rounded-md bg-muted" />
      </header>

      <ul className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <li
            key={i}
            className="flex items-center justify-between gap-4 rounded-md border border-input bg-background px-4 py-3"
          >
            <div className="flex flex-col gap-1">
              <div className="h-4 w-32 animate-pulse rounded bg-muted" />
              <div className="h-3 w-56 animate-pulse rounded bg-muted/70" />
            </div>
            <div className="h-5 w-20 animate-pulse rounded-full bg-muted" />
          </li>
        ))}
      </ul>
    </main>
  );
}
