/**
 * Audit page route segment loading UI.
 *
 * The audit page is always server-rendered with `force-dynamic`, so this
 * fallback runs while the Supabase queries are inflight. Mirrors the final
 * layout (header → cards → sankey → table) with skeleton placeholders so
 * there's no layout shift on swap.
 */
export default function AuditLoading() {
  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-8 py-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <div className="h-8 w-24 animate-pulse rounded bg-muted" />
          <div className="h-4 w-72 animate-pulse rounded bg-muted/60" />
        </div>
        <div className="h-9 w-48 animate-pulse rounded bg-muted" />
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex h-36 animate-pulse flex-col gap-3 rounded-lg border border-border bg-card p-4"
          >
            <div className="h-4 w-1/2 rounded bg-muted" />
            <div className="h-8 w-2/3 rounded bg-muted" />
            <div className="h-3 w-full rounded bg-muted/60" />
          </div>
        ))}
      </section>

      <section className="h-[320px] animate-pulse rounded-lg border border-border bg-card" />

      <section className="h-72 animate-pulse rounded-lg border border-border bg-card" />
    </main>
  );
}
