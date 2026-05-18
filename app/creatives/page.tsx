import type { Route } from "next";
import Link from "next/link";
import { Sparkles } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Creatives — VoxHorizon",
};

type CreativeRow = {
  brief_id: string;
  status: string;
  created_at: string;
};

type VideoCreativeRow = {
  brief_id: string;
  status: string;
  created_at: string;
};

type BriefHeader = {
  id: string;
  brief_id_human: string;
  status: string;
  created_at: string;
};

type Group = {
  brief: BriefHeader;
  count: number;
  latest: string;
  kind: "image" | "video";
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default async function CreativesIndexPage() {
  const supabase = await createClient();

  // Pull every creative + video_creative row tagged with its brief; group
  // client-side. The volume is small enough (low hundreds) that a single
  // round-trip per table is cheaper than a SQL aggregate roundtrip.
  const [imageRes, videoRes] = await Promise.all([
    supabase
      .from("creatives")
      .select("brief_id, status, created_at")
      .order("created_at", { ascending: false })
      .limit(1000),
    supabase
      .from("video_creatives")
      .select("brief_id, status, created_at")
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);

  const imageRows = (imageRes.data ?? []) as CreativeRow[];
  const videoRows = (videoRes.data ?? []) as VideoCreativeRow[];
  const error = imageRes.error ?? videoRes.error ?? null;

  // Map brief_id → aggregate; track latest timestamp so we can sort by
  // recent activity rather than brief creation date.
  const imageAgg = new Map<string, { count: number; latest: string }>();
  for (const r of imageRows) {
    const entry = imageAgg.get(r.brief_id);
    if (!entry || r.created_at > entry.latest) {
      imageAgg.set(r.brief_id, {
        count: (entry?.count ?? 0) + 1,
        latest: entry ? (r.created_at > entry.latest ? r.created_at : entry.latest) : r.created_at,
      });
    } else {
      entry.count += 1;
    }
  }
  const videoAgg = new Map<string, { count: number; latest: string }>();
  for (const r of videoRows) {
    const entry = videoAgg.get(r.brief_id);
    if (!entry || r.created_at > entry.latest) {
      videoAgg.set(r.brief_id, {
        count: (entry?.count ?? 0) + 1,
        latest: entry ? (r.created_at > entry.latest ? r.created_at : entry.latest) : r.created_at,
      });
    } else {
      entry.count += 1;
    }
  }

  const imageBriefIds = Array.from(imageAgg.keys());
  const videoBriefIds = Array.from(videoAgg.keys());

  // Resolve brief headers in two parallel fetches so we can render the
  // human-readable id + current status alongside each row.
  const [briefHeaders, videoBriefHeaders] = await Promise.all([
    imageBriefIds.length > 0
      ? supabase
          .from("briefs")
          .select("id, brief_id_human, status, created_at")
          .in("id", imageBriefIds)
      : Promise.resolve({ data: [] as BriefHeader[], error: null }),
    videoBriefIds.length > 0
      ? supabase
          .from("video_briefs")
          .select("id, brief_id_human, status, created_at")
          .in("id", videoBriefIds)
      : Promise.resolve({ data: [] as BriefHeader[], error: null }),
  ]);

  const groups: Group[] = [];
  for (const b of (briefHeaders.data ?? []) as BriefHeader[]) {
    const agg = imageAgg.get(b.id);
    if (!agg) continue;
    groups.push({ brief: b, count: agg.count, latest: agg.latest, kind: "image" });
  }
  for (const b of (videoBriefHeaders.data ?? []) as BriefHeader[]) {
    const agg = videoAgg.get(b.id);
    if (!agg) continue;
    groups.push({ brief: b, count: agg.count, latest: agg.latest, kind: "video" });
  }
  groups.sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));

  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Creatives</h1>
        <p className="text-sm text-muted-foreground">
          Briefs with generated variants. Open one to review, iterate, or approve.
        </p>
      </header>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Failed to load creatives: {error.message}
        </div>
      ) : null}

      {groups.length === 0 && !error ? (
        <EmptyState
          icon={<Sparkles className="h-8 w-8" aria-hidden="true" />}
          title="No creatives yet"
          description="Once a brief is approved and the worker produces variants, they'll show up here. Start by creating a brief."
          action={{ label: "Browse briefs", href: "/briefs" }}
        />
      ) : groups.length > 0 ? (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Brief</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Variants</th>
                <th className="px-3 py-2 font-medium">Latest activity</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const href = (
                  g.kind === "image" ? `/creatives/${g.brief.id}` : `/creatives/video/${g.brief.id}`
                ) as Route;
                return (
                  <tr key={`${g.kind}:${g.brief.id}`} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <Link
                        href={href}
                        className="font-mono text-xs underline-offset-4 hover:underline"
                      >
                        {g.brief.brief_id_human}
                      </Link>
                    </td>
                    <td className="px-3 py-2 capitalize text-muted-foreground">{g.kind}</td>
                    <td className="px-3 py-2">{g.count}</td>
                    <td className="px-3 py-2 text-muted-foreground">{formatDate(g.latest)}</td>
                    <td className="px-3 py-2 text-right">
                      <Link href={href} className="text-xs underline-offset-4 hover:underline">
                        Open →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </main>
  );
}
