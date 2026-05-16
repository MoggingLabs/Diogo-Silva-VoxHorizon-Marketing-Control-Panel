import Link from "next/link";
import { notFound } from "next/navigation";

import { ApprovalGate } from "@/components/brief/ApprovalGate";
import { LaunchSummary } from "@/components/launch/LaunchSummary";
import { LaunchTimeline } from "@/components/launch/LaunchTimeline";
import type { Brief } from "@/lib/briefs";
import { type Creative, getSignedUrl } from "@/lib/creatives";
import { readLaunchPayload, type LaunchPackage, type LaunchStatusT } from "@/lib/launches";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types.gen";

export const dynamic = "force-dynamic";

type CopyVariantRow = Database["public"]["Tables"]["copy_variants"]["Row"];

const STATUS_LABEL: Record<LaunchStatusT, string> = {
  validating: "Validating",
  posted: "Posted",
  approved: "Approved",
  approved_with_changes: "Approved with changes",
  rejected: "Rejected",
  failed: "Failed",
};

const STATUS_BADGE: Record<LaunchStatusT, string> = {
  validating: "bg-zinc-100 text-zinc-700",
  posted: "bg-amber-100 text-amber-900",
  approved: "bg-emerald-100 text-emerald-900",
  approved_with_changes: "bg-sky-100 text-sky-900",
  rejected: "bg-destructive/10 text-destructive",
  failed: "bg-rose-100 text-rose-800",
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Launch ${id.slice(0, 8)} — VoxHorizon` };
}

export default async function LaunchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: launchRow, error: launchErr } = await supabase
    .from("launch_packages")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (launchErr) {
    throw new Error(launchErr.message);
  }
  if (!launchRow) notFound();
  const launch = launchRow as LaunchPackage;
  const payload = readLaunchPayload(launch);
  if (!payload) {
    throw new Error("launch payload failed schema validation");
  }

  // Fetch the brief + creatives + copy variants in parallel.
  const [briefRes, creativesRes, copyRes, eventsRes] = await Promise.all([
    supabase.from("briefs").select("*").eq("id", launch.brief_id).maybeSingle(),
    payload.creative_ids.length
      ? supabase.from("creatives").select("*").in("id", payload.creative_ids)
      : Promise.resolve({ data: [] as Creative[], error: null }),
    payload.copy_variant_ids.length
      ? supabase.from("copy_variants").select("*").in("id", payload.copy_variant_ids)
      : Promise.resolve({ data: [] as CopyVariantRow[], error: null }),
    supabase
      .from("events")
      .select("id, kind, created_at, payload")
      .eq("ref_table", "launch_packages")
      .eq("ref_id", id)
      .order("created_at", { ascending: true })
      .limit(200),
  ]);

  if (briefRes.error) throw new Error(briefRes.error.message);
  if (!briefRes.data) notFound();

  const brief = briefRes.data as Brief;
  const creatives = (creativesRes.data ?? []) as Creative[];
  const copyVariants = (copyRes.data ?? []) as CopyVariantRow[];

  const copyByCreativeId: Record<string, CopyVariantRow[]> = {};
  for (const cv of copyVariants) {
    if (!cv.creative_id) continue;
    const list = copyByCreativeId[cv.creative_id] ?? [];
    list.push(cv);
    copyByCreativeId[cv.creative_id] = list;
  }

  // Sign URLs for each creative thumbnail (admin client — bypasses RLS).
  const admin = createAdminClient();
  const signedEntries = await Promise.all(
    creatives.map(async (c) => [c.id, await getSignedUrl(admin, c.file_path_supabase)] as const),
  );
  const signedUrls: Record<string, string | null> = Object.fromEntries(signedEntries);

  const status = launch.status as LaunchStatusT;

  return (
    <main className="container mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 py-12">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">
          <Link href="/launches" className="underline-offset-4 hover:underline">
            Launches
          </Link>{" "}
          / <span className="font-mono">{payload.brief_id_human}</span>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            Launch package — {payload.client?.name ?? "—"}
          </h1>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs ${STATUS_BADGE[status] ?? STATUS_BADGE.posted}`}
          >
            {STATUS_LABEL[status] ?? status}
          </span>
        </div>
      </header>

      {launch.decided_at ? (
        <section className="space-y-1 rounded-md border bg-muted/30 px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Decision</p>
          <p className="text-sm">
            {STATUS_LABEL[status] ?? status}
            <span className="text-muted-foreground">
              {" "}
              · {new Date(launch.decided_at).toLocaleString()}
            </span>
          </p>
          {launch.decided_notes ? (
            <p className="mt-1 whitespace-pre-wrap text-sm">{launch.decided_notes}</p>
          ) : null}
        </section>
      ) : null}

      <LaunchSummary
        brief={brief}
        creatives={creatives}
        copyByCreativeId={copyByCreativeId}
        signedUrls={signedUrls}
        payload={payload}
      />

      {status === "posted" ? (
        <ApprovalGate
          briefId={launch.id}
          kind="launch"
          endpoint={`/api/launches/${launch.id}/decision`}
        />
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Timeline</h2>
        <LaunchTimeline launchId={launch.id} initialEvents={eventsRes.data ?? []} />
      </section>
    </main>
  );
}
