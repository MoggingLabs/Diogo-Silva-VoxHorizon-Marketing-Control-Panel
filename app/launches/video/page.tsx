import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { readVideoLaunchPayload, type VideoLaunchStatusT } from "@/lib/video-launches";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<VideoLaunchStatusT, string> = {
  validating: "Validating",
  posted: "Posted",
  approved: "Approved",
  approved_with_changes: "Approved with changes",
  rejected: "Rejected",
  failed: "Failed",
};

const STATUS_PILL: Record<VideoLaunchStatusT, string> = {
  validating: "bg-zinc-100 text-zinc-700",
  posted: "bg-amber-100 text-amber-900",
  approved: "bg-emerald-100 text-emerald-900",
  approved_with_changes: "bg-sky-100 text-sky-900",
  rejected: "bg-destructive/10 text-destructive",
  failed: "bg-rose-100 text-rose-800",
};

/**
 * Minimal video launches list. Mirrors `/launches/page.tsx`.
 */
export default async function VideoLaunchesIndexPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("video_launch_packages")
    .select("id, brief_id, status, payload, created_at, decided_at")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <main className="container mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Video launches</h1>
        <p className="text-sm text-muted-foreground">
          Video launch packages.{" "}
          <Link href="/launches" className="underline-offset-4 hover:underline">
            ← Image launches
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
          No video launches yet. Build one via POST /api/launches/video.
        </p>
      ) : null}

      <ul className="space-y-2">
        {(data ?? []).map((row) => {
          const status = row.status as VideoLaunchStatusT;
          const payload = readVideoLaunchPayload(row);
          return (
            <li
              key={row.id}
              className="flex flex-wrap items-baseline justify-between gap-3 rounded-md border bg-card px-3 py-2 shadow-sm"
            >
              <div className="flex flex-1 flex-wrap items-baseline gap-3">
                <Link
                  href={{ pathname: `/launches/video/${row.id}` }}
                  className="text-sm font-medium underline-offset-4 hover:underline"
                >
                  {payload?.brief_id_human ?? row.id.slice(0, 8)}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {payload?.client?.name ?? "—"}
                </span>
              </div>
              <div className="flex items-center gap-2">
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
