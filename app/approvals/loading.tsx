/**
 * Loading skeleton for `/approvals`. Streams in while the server component
 * fetches the latest 200 rows; the layout matches the final page so the
 * transition is unobtrusive.
 */
export default function ApprovalsLoading() {
  return (
    <main
      className="container mx-auto flex min-h-dvh flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-6 sm:py-8"
      data-testid="approvals-loading"
    >
      <div className="flex flex-col gap-1">
        <div className="h-7 w-40 animate-pulse rounded bg-muted" />
        <div className="h-4 w-72 animate-pulse rounded bg-muted/60" />
      </div>
      <div className="h-20 animate-pulse rounded-md border border-border bg-card" />
      <ul className="flex flex-col gap-2" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="h-12 animate-pulse rounded-md border border-border bg-card" />
        ))}
      </ul>
    </main>
  );
}
