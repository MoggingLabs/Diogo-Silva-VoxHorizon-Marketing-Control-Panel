import Link from "next/link";
import { notFound } from "next/navigation";

import { VideoVariantsGrid } from "@/components/creative/VideoVariantsGrid";
import {
  ScriptOutline,
  type ScriptOutlineT,
  type VideoBrief,
  type VideoBriefStatusT,
} from "@/lib/video-briefs";
import {
  STATUS_LABEL,
  STATUS_PILL,
  getSignedUrl,
  type VideoCreative,
  type VideoCreativeStatusT,
} from "@/lib/video-creatives";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ briefId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps) {
  const { briefId } = await params;
  return { title: `Video creatives ${briefId.slice(0, 12)} — VoxHorizon` };
}

const BRIEF_STATUS_LABEL: Record<VideoBriefStatusT, string> = {
  draft: "Draft",
  posted: "Posted",
  approved: "Approved",
  approved_with_changes: "Approved with changes",
  rejected: "Rejected",
};

const BRIEF_STATUS_PILL: Record<VideoBriefStatusT, string> = {
  draft: "bg-zinc-100 text-zinc-700",
  posted: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  approved_with_changes: "bg-sky-100 text-sky-800",
  rejected: "bg-rose-100 text-rose-800",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a video brief by either its UUID `id` or its human-friendly
 * `brief_id_human`. Returns `null` when neither lookup hits.
 */
async function lookupBrief(
  supabase: Awaited<ReturnType<typeof createClient>>,
  briefId: string,
): Promise<VideoBrief | null> {
  const looksLikeUuid = UUID_RE.test(briefId);
  const column = looksLikeUuid ? "id" : "brief_id_human";
  const { data, error } = await supabase
    .from("video_briefs")
    .select("*")
    .eq(column, briefId)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return (data as VideoBrief | null) ?? null;
}

async function lookupClient(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clientId: string | null,
): Promise<{ id: string; name: string; slug: string } | null> {
  if (!clientId) return null;
  const { data } = await supabase
    .from("clients")
    .select("id, name, slug")
    .eq("id", clientId)
    .maybeSingle();
  return (data as { id: string; name: string; slug: string } | null) ?? null;
}

export default async function VideoCreativesByBriefPage({ params, searchParams }: PageProps) {
  const { briefId } = await params;
  const search = await searchParams;
  const rawSelected = Array.isArray(search.creative) ? search.creative[0] : search.creative;
  const selectedId = rawSelected && UUID_RE.test(rawSelected) ? rawSelected : null;

  const supabase = await createClient();
  const brief = await lookupBrief(supabase, briefId);
  if (!brief) notFound();

  const [client, creativesRes] = await Promise.all([
    lookupClient(supabase, brief.client_id),
    supabase
      .from("video_creatives")
      .select("*")
      .eq("brief_id", brief.id)
      .order("created_at", { ascending: true })
      .limit(200),
  ]);

  if (creativesRes.error) {
    throw new Error(creativesRes.error.message);
  }
  const creatives = (creativesRes.data ?? []) as VideoCreative[];

  // Resolve signed URLs server-side so the first paint shows previews
  // without an extra round-trip. Each creative has up to three relevant
  // paths (captioned MP4, composed MP4, voiceover MP3) — fetch them in
  // parallel.
  const admin = createAdminClient();
  const signedBundleEntries = await Promise.all(
    creatives.map(async (c) => {
      const [captioned, composed, voiceover] = await Promise.all([
        getSignedUrl(admin, c.captioned_path),
        getSignedUrl(admin, c.composed_path),
        getSignedUrl(admin, c.voiceover_path),
      ]);
      return [c.id, { captioned, composed, voiceover }] as const;
    }),
  );
  const signedUrls: Record<
    string,
    { captioned: string | null; composed: string | null; voiceover: string | null }
  > = Object.fromEntries(signedBundleEntries);

  const outlineParse = ScriptOutline.safeParse(brief.script_outline);
  const outline: ScriptOutlineT | null = outlineParse.success ? outlineParse.data : null;

  const briefStatus = brief.status as VideoBriefStatusT;
  const briefPillClass = BRIEF_STATUS_PILL[briefStatus] ?? "bg-zinc-100 text-zinc-700";
  const briefPillLabel = BRIEF_STATUS_LABEL[briefStatus] ?? briefStatus;

  const counts = creatives.reduce(
    (acc, c) => {
      const status = c.status as VideoCreativeStatusT;
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    },
    {} as Record<VideoCreativeStatusT, number>,
  );
  const orderedCountKeys: VideoCreativeStatusT[] = [
    "draft",
    "script_ready",
    "voiceover_ready",
    "broll_ready",
    "composed",
    "captioned",
    "approved",
    "rejected",
  ];

  return (
    <main className="container mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">
          <Link href="/briefs/video" className="underline-offset-4 hover:underline">
            Video briefs
          </Link>{" "}
          /{" "}
          <Link
            href={`/briefs/video/${brief.id}`}
            className="break-all font-mono text-xs underline-offset-4 hover:underline"
          >
            {brief.brief_id_human}
          </Link>{" "}
          / <span>Video creatives</span>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            Video creative variants
          </h1>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs ${briefPillClass}`}
          >
            Brief: {briefPillLabel}
          </span>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          {client ? (
            <Meta label="Client">
              <span className="text-foreground">{client.name}</span>
              <span className="font-mono"> · {client.slug}</span>
            </Meta>
          ) : (
            <Meta label="Client">No client</Meta>
          )}
          {brief.target_duration_s ? (
            <Meta label="Target duration">
              <span className="font-mono text-foreground">{brief.target_duration_s}s</span>
            </Meta>
          ) : null}
          {brief.dimensions ? (
            <Meta label="Dimensions">
              <span className="font-mono text-foreground">{brief.dimensions}</span>
            </Meta>
          ) : null}
          {brief.voice_id ? (
            <Meta label="Voice">
              <span className="font-mono text-foreground">{brief.voice_id}</span>
            </Meta>
          ) : null}
          {outline ? (
            <Meta label="Segments">
              <span className="text-foreground">{outline.segments.length}</span>
            </Meta>
          ) : null}
          <Meta label="Variants">
            <span className="text-foreground">{creatives.length}</span>
          </Meta>
        </dl>

        {creatives.length > 0 ? (
          <div className="flex flex-wrap gap-2 text-[11px]">
            {orderedCountKeys.map((key) => {
              const n = counts[key] ?? 0;
              if (n === 0) return null;
              return (
                <span
                  key={key}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium ${STATUS_PILL[key]}`}
                >
                  {STATUS_LABEL[key]}
                  <span className="font-mono">{n}</span>
                </span>
              );
            })}
          </div>
        ) : null}
      </header>

      <VideoVariantsGrid
        brief={brief}
        initialCreatives={creatives}
        initialSignedUrls={signedUrls}
        selectedId={selectedId}
      />
    </main>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="text-[10px] uppercase tracking-wide">{label}</dt>
      <dd className="text-xs">{children}</dd>
    </div>
  );
}
