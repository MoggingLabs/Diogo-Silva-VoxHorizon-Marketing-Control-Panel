import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { readLaunchPayload, type LaunchStatusT } from "@/lib/launches";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<LaunchStatusT, string> = {
  validating: "Validating",
  posted: "Posted",
  approved: "Approved",
  approved_with_changes: "Approved with changes",
  rejected: "Rejected",
  failed: "Failed",
};

const STATUS_PILL: Record<LaunchStatusT, string> = {
  validating: "bg-zinc-100 text-zinc-700",
  posted: "bg-amber-100 text-amber-900",
  approved: "bg-emerald-100 text-emerald-900",
  approved_with_changes: "bg-sky-100 text-sky-900",
  rejected: "bg-destructive/10 text-destructive",
  failed: "bg-rose-100 text-rose-800",
};

/**
 * Minimal launches list (image side). Newest-first, no pagination.
 * Useful as the breadcrumb target from individual launch pages and for
 * spot-checking pre-flight outcomes.
 */
export default async function LaunchesIndexPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("launch_packages")
    .select("id, brief_id, status, payload, created_at, decided_at")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <main className="container mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Launches</h1>
        <p className="text-sm text-muted-foreground">
          Image launch packages. Click into one to review the bundle + decide.{" "}
          <Link href="/launches/video" className="underline-offset-4 hover:underline">
            Video launches →
          </Link>
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error.message}
        </div>
      ) : null}

      {!error && (data?.length ?? 0) === 0 ? (
        <p className="rounded-md border border-dashed bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
          No launches yet. Build one from an approved brief via POST /api/launches.
        </p>
      ) : null}

      <ul className="space-y-2">
        {(data ?? []).map((row) => {
          const status = row.status as LaunchStatusT;
          const payload = readLaunchPayload(row);
          return (
            <li
              key={row.id}
              className="flex flex-wrap items-baseline justify-between gap-3 rounded-md border bg-card px-3 py-3 shadow-sm sm:py-2"
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2 sm:gap-3">
                <Link
                  href={{ pathname: `/launches/${row.id}` }}
                  className="break-all text-sm font-medium underline-offset-4 hover:underline"
                >
                  {payload?.brief_id_human ?? row.id.slice(0, 8)}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {payload?.client?.name ?? "—"}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${STATUS_PILL[status] ?? "bg-zinc-100 text-zinc-700"}`}
                >
                  {STATUS_LABEL[status] ?? status}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(row.created_at).toLocaleDateString()}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
