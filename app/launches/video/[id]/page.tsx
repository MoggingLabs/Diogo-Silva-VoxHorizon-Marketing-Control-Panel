import Link from "next/link";
import { notFound } from "next/navigation";

import { AdEntityGraph } from "@/components/launch/AdEntityGraph";
import { LaunchPackageActions } from "@/components/launch/LaunchPackageActions";
import { LaunchTimeline } from "@/components/launch/LaunchTimeline";
import { VideoLaunchApprovalGate } from "@/components/launch/VideoLaunchApprovalGate";
import { VideoLaunchSummary } from "@/components/launch/VideoLaunchSummary";
import { getAdEntitiesForLaunch } from "@/lib/ad-entity";
import { CREATIVES_BUCKET } from "@/lib/creatives";
import {
  readVideoLaunchPayload,
  type VideoLaunchPackage,
  type VideoLaunchStatusT,
} from "@/lib/video-launches";
import type { VideoBrief } from "@/lib/video-briefs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types.gen";

export const dynamic = "force-dynamic";

type VideoCreativeRow = Database["public"]["Tables"]["video_creatives"]["Row"];
type VideoCopyVariantRow = Database["public"]["Tables"]["video_copy_variants"]["Row"];

const STATUS_LABEL: Record<VideoLaunchStatusT, string> = {
  validating: "Validating",
  posted: "Posted",
  approved: "Approved",
  approved_with_changes: "Approved with changes",
  rejected: "Rejected",
  failed: "Failed",
};

const STATUS_BADGE: Record<VideoLaunchStatusT, string> = {
  validating: "bg-zinc-100 text-zinc-700",
  posted: "bg-amber-100 text-amber-900",
  approved: "bg-emerald-100 text-emerald-900",
  approved_with_changes: "bg-sky-100 text-sky-900",
  rejected: "bg-destructive/10 text-destructive",
  failed: "bg-rose-100 text-rose-800",
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Video launch ${id.slice(0, 8)} — VoxHorizon` };
}

export default async function VideoLaunchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: launchRow, error: launchErr } = await supabase
    .from("video_launch_packages")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (launchErr) throw new Error(launchErr.message);
  if (!launchRow) notFound();
  const launch = launchRow as VideoLaunchPackage;
  const payload = readVideoLaunchPayload(launch);
  if (!payload) {
    throw new Error("video launch payload failed schema validation");
  }

  const adEntities = await getAdEntitiesForLaunch(launch.id);
  const [briefRes, creativesRes, copyRes, eventsRes] = await Promise.all([
    supabase
      .from("video_briefs")
      .select("*, clients(name, slug)")
      .eq("id", launch.brief_id)
      .maybeSingle(),
    payload.video_creative_ids.length
      ? supabase.from("video_creatives").select("*").in("id", payload.video_creative_ids)
      : Promise.resolve({ data: [] as VideoCreativeRow[], error: null }),
    payload.copy_variant_ids.length
      ? supabase.from("video_copy_variants").select("*").in("id", payload.copy_variant_ids)
      : Promise.resolve({ data: [] as VideoCopyVariantRow[], error: null }),
    supabase
      .from("events")
      .select("id, kind, created_at, payload")
      .eq("ref_table", "video_launch_packages")
      .eq("ref_id", id)
      .order("created_at", { ascending: true })
      .limit(200),
  ]);

  if (briefRes.error) throw new Error(briefRes.error.message);
  if (!briefRes.data) notFound();

  const brief = briefRes.data as VideoBrief & {
    clients: { name: string; slug: string } | null;
  };
  const videoCreatives = (creativesRes.data ?? []) as VideoCreativeRow[];
  const copyVariants = (copyRes.data ?? []) as VideoCopyVariantRow[];

  const copyByCreativeId: Record<string, VideoCopyVariantRow[]> = {};
  for (const cv of copyVariants) {
    if (!cv.creative_id) continue;
    const list = copyByCreativeId[cv.creative_id] ?? [];
    list.push(cv);
    copyByCreativeId[cv.creative_id] = list;
  }

  // Sign URLs for each video creative's captioned cut. Mirrors the image
  // side except we sign the .mp4 path rather than a .png.
  const admin = createAdminClient();
  const signedEntries = await Promise.all(
    videoCreatives.map(async (c) => {
      if (!c.captioned_path) return [c.id, null] as const;
      const { data, error } = await admin.storage
        .from(CREATIVES_BUCKET)
        .createSignedUrl(c.captioned_path, 3600);
      if (error || !data?.signedUrl) {
        return [c.id, null] as const;
      }
      return [c.id, data.signedUrl] as const;
    }),
  );
  const signedUrls: Record<string, string | null> = Object.fromEntries(signedEntries);

  const status = launch.status as VideoLaunchStatusT;

  return (
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
              Video launch — {payload.client?.name ?? brief.clients?.name ?? "—"}
            </h1>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs ${STATUS_BADGE[status] ?? STATUS_BADGE.posted}`}
            >
              {STATUS_LABEL[status] ?? status}
            </span>
          </div>
          <div className="self-start">
            <LaunchPackageActions
              format="video"
              launchId={launch.id}
              decidedNotes={launch.decided_notes}
              archived={launch.deleted_at !== null}
            />
          </div>
        </div>
      </header>

      {launch.deleted_at ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          This video launch package is archived and hidden from the active list. Restore it to bring
          it back.
        </div>
      ) : null}

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

      <VideoLaunchSummary
        brief={brief}
        videoCreatives={videoCreatives}
        copyByCreativeId={copyByCreativeId}
        signedUrls={signedUrls}
        payload={payload}
      />

      {status === "posted" ? <VideoLaunchApprovalGate launchId={launch.id} /> : null}

      <AdEntityGraph entities={adEntities} />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Timeline</h2>
        <LaunchTimeline
          launchId={launch.id}
          table="video_launch_packages"
          initialEvents={eventsRes.data ?? []}
        />
      </section>
    </main>
  );
}
