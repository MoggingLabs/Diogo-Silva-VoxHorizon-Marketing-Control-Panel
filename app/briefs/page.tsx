import Link from "next/link";
import { ClipboardList } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { readBriefPayload, type Brief, type BriefStatusT } from "@/lib/briefs";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Briefs — VoxHorizon",
};

const STATUS_ORDER: BriefStatusT[] = [
  "draft",
  "posted",
  "approved",
  "approved_with_changes",
  "rejected",
];

const STATUS_LABEL: Record<BriefStatusT, string> = {
  draft: "Draft",
  posted: "Posted",
  approved: "Approved",
  approved_with_changes: "Approved w/ changes",
  rejected: "Rejected",
};

const STATUS_BADGE: Record<BriefStatusT, string> = {
  draft: "bg-muted text-muted-foreground",
  posted: "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  approved: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  approved_with_changes: "bg-sky-100 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
  rejected: "bg-destructive/10 text-destructive",
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default async function BriefsListPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("briefs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  const briefs: Brief[] = (data ?? []) as Brief[];

  // Group by status for a simple board-ish view (the proper Kanban lands in
  // M1-7 / Wave 2). Falls back to a flat list when nothing is grouped.
  const grouped: Record<BriefStatusT, Brief[]> = {
    draft: [],
    posted: [],
    approved: [],
    approved_with_changes: [],
    rejected: [],
  };
  for (const b of briefs) {
    grouped[b.status]?.push(b);
  }

  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Briefs</h1>
        <Button asChild>
          <Link href="/briefs/new">New brief</Link>
        </Button>
      </header>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Failed to load briefs: {error.message}
        </div>
      ) : null}

      {briefs.length === 0 && !error ? (
        <EmptyState
          icon={<ClipboardList className="h-8 w-8" aria-hidden="true" />}
          title="No briefs yet"
          description="Create your first image brief to start drafting creative variants."
          action={{ label: "New brief", href: "/briefs/new" }}
        />
      ) : briefs.length > 0 ? (
        <div className="space-y-8">
          {STATUS_ORDER.map((status) => {
            const rows = grouped[status];
            if (rows.length === 0) return null;
            return (
              <section key={status} className="space-y-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold">{STATUS_LABEL[status]}</h2>
                  <span className="text-xs text-muted-foreground">{rows.length}</span>
                </div>
                <div className="overflow-hidden rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Human ID</th>
                        <th className="px-3 py-2 font-medium">Market</th>
                        <th className="px-3 py-2 font-medium">Service</th>
                        <th className="px-3 py-2 font-medium">Budget</th>
                        <th className="px-3 py-2 font-medium">Created</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((b) => {
                        const payload = readBriefPayload(b);
                        return (
                          <tr key={b.id} className="border-t hover:bg-muted/30">
                            <td className="px-3 py-2">
                              <Link
                                href={`/briefs/${b.id}`}
                                className="font-mono text-xs underline-offset-4 hover:underline"
                              >
                                {b.brief_id_human}
                              </Link>
                            </td>
                            <td className="px-3 py-2">{payload?.market ?? "—"}</td>
                            <td className="px-3 py-2 capitalize">{payload?.service ?? "—"}</td>
                            <td className="px-3 py-2">
                              {typeof payload?.budget === "number"
                                ? `$${payload.budget.toLocaleString()}`
                                : "—"}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {formatDate(b.created_at)}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[b.status]}`}
                              >
                                {STATUS_LABEL[b.status]}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </div>
      ) : null}
    </main>
  );
}
