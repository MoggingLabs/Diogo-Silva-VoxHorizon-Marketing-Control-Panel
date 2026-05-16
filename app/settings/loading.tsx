/**
 * Skeleton for the settings page. Mirrors the stacked sections + def-list
 * geometry.
 */
export default function SettingsLoading() {
  return (
    <main
      className="container mx-auto flex min-h-dvh max-w-3xl flex-col gap-8 py-12"
      aria-busy="true"
    >
      <header className="flex flex-col gap-2">
        <div className="h-9 w-40 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-72 animate-pulse rounded-md bg-muted/70" />
      </header>

      {Array.from({ length: 5 }).map((_, s) => (
        <section key={s} className="flex flex-col gap-3">
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
          <div className="grid grid-cols-[10rem_1fr] items-baseline gap-x-4 gap-y-2 rounded-md border bg-background p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="contents">
                <div className="h-3 w-24 animate-pulse rounded bg-muted/70" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
