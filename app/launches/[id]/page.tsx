import Link from "next/link";
import { notFound } from "next/navigation";

import { AdEntityGraph } from "@/components/launch/AdEntityGraph";
import { LaunchApprovalGate } from "@/components/launch/LaunchApprovalGate";
import {
  LaunchStatusBadge,
  LaunchStatusProvider,
  launchStatusLabel,
} from "@/components/launch/LaunchStatusBadge";
import { LaunchPackageActions } from "@/components/launch/LaunchPackageActions";
import { LaunchSummary } from "@/components/launch/LaunchSummary";
import { LaunchTimeline } from "@/components/launch/LaunchTimeline";
import { getAdEntitiesForLaunch } from "@/lib/ad-entity";
import type { Brief } from "@/lib/briefs";
import { type Creative, getSignedUrl } from "@/lib/creatives";
import { readLaunchPayload, type LaunchPackage, type LaunchStatusT } from "@/lib/launches";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types.gen";

export const dynamic = "force-dynamic";

type CopyVariantRow = Database["public"]["Tables"]["copy_variants"]["Row"];

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

  // Fetch the recorded ad entities + brief + creatives + copy variants +
  // events in one parallel batch. They are all independent of each other, so
  // the ad-entity graph should not take its own serial round-trip (~140ms to
  // us-east) ahead of the rest.
  const [adEntities, briefRes, creativesRes, copyRes, eventsRes] = await Promise.all([
    getAdEntitiesForLaunch(launch.id),
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
    <LaunchStatusProvider key={status} serverStatus={status}>
      <main className="container mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
        <header className="space-y-2">
          <p className="text-sm text-muted-foreground">
            <Link href="/launches" className="underline-offset-4 hover:underline">
              Launches
            </Link>{" "}
            / <span className="break-all font-mono">{payload.brief_id_human}</span>
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                Launch package — {payload.client?.name ?? "—"}
              </h1>
              <LaunchStatusBadge status={status} />
            </div>
            <div className="self-start">
              <LaunchPackageActions
                format="image"
                launchId={launch.id}
                decidedNotes={launch.decided_notes}
                archived={launch.deleted_at !== null}
              />
            </div>
          </div>
        </header>

        {launch.deleted_at ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            This launch package is archived and hidden from the active list. Restore it to bring it
            back.
          </div>
        ) : null}

        {launch.decided_at ? (
          <section className="space-y-1 rounded-md border bg-muted/30 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Decision</p>
            <p className="text-sm">
              {launchStatusLabel(status)}
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

        {status === "posted" ? <LaunchApprovalGate launchId={launch.id} /> : null}

        <AdEntityGraph entities={adEntities} />

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Timeline</h2>
          <LaunchTimeline launchId={launch.id} initialEvents={eventsRes.data ?? []} />
        </section>
      </main>
    </LaunchStatusProvider>
  );
}
