import Link from "next/link";
import { notFound } from "next/navigation";

import { VideoApprovalGate } from "@/components/brief/VideoApprovalGate";
import { VideoBriefTimeline } from "@/components/brief/VideoBriefTimeline";
import { createClient } from "@/lib/supabase/server";
import {
  ScriptOutline,
  totalSegmentDuration,
  type ScriptOutlineT,
  type VideoBrief,
} from "@/lib/video-briefs";

export const dynamic = "force-dynamic";

const STATUS_LABEL_CLASSES: Record<string, string> = {
  draft: "bg-secondary text-secondary-foreground",
  posted: "bg-primary text-primary-foreground",
  approved: "bg-emerald-600 text-white",
  approved_with_changes: "bg-amber-500 text-white",
  rejected: "bg-destructive text-destructive-foreground",
};

type PageProps = { params: Promise<{ id: string }> };

/**
 * /briefs/video/[id] — single video brief detail.
 *
 * Renders the structured payload (hook + segments tree + duration + voice
 * + style summary), an append-only `<VideoBriefTimeline />` realtime view
 * of the `events` table scoped to this brief, and a `<VideoApprovalGate />`
 * when `status=posted`.
 *
 * Implements V1-6 (#83) and the UI side of V1-9 (#86).
 */
export default async function VideoBriefDetailPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();

  const [briefRes, eventsRes] = await Promise.all([
    supabase.from("video_briefs").select("*, clients(name, slug)").eq("id", id).maybeSingle(),
    supabase
      .from("events")
      .select("id, kind, created_at, payload")
      .eq("ref_table", "video_briefs")
      .eq("ref_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (briefRes.error) {
    return (
      <main className="container mx-auto flex min-h-dvh flex-col gap-6 py-12">
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          Failed to load video brief: {briefRes.error.message}
        </div>
      </main>
    );
  }
  if (!briefRes.data) {
    notFound();
  }

  const brief = briefRes.data as VideoBrief & {
    clients: { name: string; slug: string } | null;
  };
  const events = eventsRes.data ?? [];

  // Defensive parse: the column is jsonb so it may not match the zod shape
  // on legacy rows. Fall back to undefined and show a friendly note.
  const outlineParse = ScriptOutline.safeParse(brief.script_outline);
  const outline: ScriptOutlineT | null = outlineParse.success ? outlineParse.data : null;
  const sum = outline ? totalSegmentDuration(outline.segments) : 0;

  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-2">
        <Link href="/briefs/video" className="text-sm text-muted-foreground hover:text-foreground">
          ← Video briefs
        </Link>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="break-all font-mono text-2xl font-semibold tracking-tight sm:text-3xl">
            {brief.brief_id_human}
          </h1>
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              STATUS_LABEL_CLASSES[brief.status] ?? "bg-secondary text-secondary-foreground"
            }`}
          >
            {brief.status}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {brief.clients?.name ?? "—"} ·{" "}
          {brief.target_duration_s ? `${brief.target_duration_s}s` : "—"} ·{" "}
          {brief.dimensions ?? "—"} · voice{" "}
          <span className="break-all font-mono">{brief.voice_id ?? "—"}</span>
        </p>
      </header>

      {/* Decision banner --------------------------------------------------- */}
      {brief.decided_at && (
        <section className="rounded-md border border-input bg-background p-4">
          <h2 className="text-lg font-semibold">Decision</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {new Date(brief.decided_at).toLocaleString()} · <strong>{brief.status}</strong>
            {brief.decided_by ? <> · by {brief.decided_by}</> : null}
          </p>
          {brief.decided_notes && (
            <p className="mt-2 whitespace-pre-wrap text-sm">{brief.decided_notes}</p>
          )}
        </section>
      )}

      {/* Approval gate ----------------------------------------------------- */}
      {brief.status === "posted" && (
        <section>
          <VideoApprovalGate videoBriefId={brief.id} />
        </section>
      )}

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Brief content -------------------------------------------------- */}
        <section className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-md border border-input bg-background p-4">
            <h2 className="text-lg font-semibold">Script outline</h2>
            {outline ? (
              <div className="mt-3 flex flex-col gap-4">
                <div>
                  <div className="text-xs font-medium uppercase text-muted-foreground">Hook</div>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{outline.hook}</p>
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium uppercase text-muted-foreground">
                      Segments ({outline.segments.length})
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Sum <strong>{sum.toFixed(0)}s</strong> / target{" "}
                      <strong>{brief.target_duration_s ?? "—"}s</strong>
                    </div>
                  </div>
                  <ol className="mt-2 flex flex-col gap-2">
                    {outline.segments.map((seg, idx) => (
                      <li key={idx} className="rounded-sm border border-input/60 bg-muted/30 p-3">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-sm font-medium">
                            {idx + 1}. {seg.topic}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {seg.duration_s}s
                          </span>
                        </div>
                        {seg.broll_theme && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            B-roll: {seg.broll_theme}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                No structured script outline saved.
              </p>
            )}
          </div>

          <div className="rounded-md border border-input bg-background p-4">
            <h2 className="text-lg font-semibold">Style</h2>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Hook style</dt>
              <dd>{brief.hook_style ?? "—"}</dd>
              <dt className="text-muted-foreground">Captions</dt>
              <dd>{brief.captions_style ?? "—"}</dd>
              <dt className="text-muted-foreground">Music</dt>
              <dd>{brief.music_track ?? "—"}</dd>
              <dt className="text-muted-foreground">B-roll selection</dt>
              <dd>{brief.broll_selection_mode}</dd>
            </dl>
          </div>
        </section>

        {/* Timeline ------------------------------------------------------- */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Timeline</h2>
          <VideoBriefTimeline
            videoBriefId={brief.id}
            initialEvents={events.map((e) => ({
              id: e.id,
              kind: e.kind,
              created_at: e.created_at,
              payload:
                typeof e.payload === "object" && e.payload !== null && !Array.isArray(e.payload)
                  ? (e.payload as Record<string, unknown>)
                  : null,
            }))}
          />
        </section>
      </div>
    </main>
  );
}
