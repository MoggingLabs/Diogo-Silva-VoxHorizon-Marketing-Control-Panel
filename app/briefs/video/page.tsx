import Link from "next/link";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const STATUS_BADGE_CLASSES: Record<string, string> = {
  draft: "bg-secondary text-secondary-foreground",
  posted: "bg-primary text-primary-foreground",
  approved: "bg-emerald-600 text-white",
  approved_with_changes: "bg-amber-500 text-white",
  rejected: "bg-destructive text-destructive-foreground",
};

/**
 * /briefs/video — newest-first index of video briefs.
 *
 * Server-rendered list; full Kanban view lands in V1-7 (Wave 2).
 */
export default async function VideoBriefsIndexPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("video_briefs")
    .select(
      "id, brief_id_human, status, target_duration_s, created_at, posted_at, decided_at, client_id, clients(slug, name)",
    )
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Video briefs</h1>
          <p className="text-sm text-muted-foreground">
            Newest first. Kanban view ships in Wave 2.
          </p>
        </div>
        <Button asChild className="self-start sm:self-auto">
          <Link href="/briefs/video/new">New video brief</Link>
        </Button>
      </header>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          Failed to load video briefs: {error.message}
        </div>
      )}

      {!error && (data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No video briefs yet.{" "}
          <Link href="/briefs/video/new" className="underline">
            Create the first one.
          </Link>
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {(data ?? []).map((b) => {
            const client = Array.isArray(b.clients) ? b.clients[0] : b.clients;
            return (
              <li key={b.id} className="rounded-md border border-input bg-background">
                <Link
                  href={`/briefs/video/${b.id}`}
                  className="flex min-h-[64px] flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-accent active:bg-accent/70 sm:gap-4"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="break-all font-mono text-sm">{b.brief_id_human}</span>
                    <span className="text-xs text-muted-foreground">
                      {client?.name ?? "—"} ·{" "}
                      {b.target_duration_s ? `${b.target_duration_s}s` : "—"} · created{" "}
                      {new Date(b.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      STATUS_BADGE_CLASSES[b.status] ?? "bg-secondary text-secondary-foreground"
                    }`}
                  >
                    {b.status}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
