import type { VideoLaunchPayloadT } from "@/lib/video-launches";
import type { VideoBrief } from "@/lib/video-briefs";
import type { Database } from "@/lib/supabase/types.gen";

type VideoCreativeRow = Database["public"]["Tables"]["video_creatives"]["Row"];
type VideoCopyVariantRow = Database["public"]["Tables"]["video_copy_variants"]["Row"];

export interface VideoLaunchSummaryProps {
  brief: VideoBrief & { clients?: { name: string; slug: string } | null };
  videoCreatives: VideoCreativeRow[];
  copyByCreativeId: Record<string, VideoCopyVariantRow[]>;
  signedUrls: Record<string, string | null>;
  payload: VideoLaunchPayloadT;
}

/**
 * Read-only summary of a video launch package.
 *
 * Renders:
 *   - Brief headline (target duration / dimensions / voice).
 *   - Issues banner if validation surfaced any.
 *   - One row per approved video creative with:
 *       * inline <video> for the final captioned cut
 *       * Drive link + composed-vs-captioned indicator
 *       * b-roll segment summary (when available)
 *       * stacked copy variants
 */
export function VideoLaunchSummary({
  brief,
  videoCreatives,
  copyByCreativeId,
  signedUrls,
  payload,
}: VideoLaunchSummaryProps) {
  return (
    <section className="space-y-6">
      <header className="space-y-2 rounded-md border bg-card p-4 shadow-sm">
        <h2 className="text-lg font-semibold">Video brief overview</h2>
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Field label="Brief" value={<span className="font-mono">{brief.brief_id_human}</span>} />
          <Field label="Client" value={payload.client?.name ?? brief.clients?.name ?? "—"} />
          <Field
            label="Duration"
            value={brief.target_duration_s ? `${brief.target_duration_s}s` : "—"}
          />
          <Field label="Dimensions" value={brief.dimensions ?? "—"} />
          <Field label="Voice" value={<span className="font-mono">{brief.voice_id ?? "—"}</span>} />
          <Field label="Captions" value={brief.captions_style ?? "—"} />
          <Field label="Hook style" value={brief.hook_style ?? "—"} />
          <Field label="Music" value={brief.music_track ?? "—"} />
        </dl>
      </header>

      {payload.issues.length > 0 ? (
        <section
          className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm"
          aria-label="Launch validation issues"
        >
          <h2 className="font-semibold text-amber-900">
            Validation issues ({payload.issues.length})
          </h2>
          <ul className="space-y-1">
            {payload.issues.map((issue, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span
                  className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-xs font-medium uppercase ${
                    issue.severity === "error"
                      ? "bg-rose-100 text-rose-800"
                      : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {issue.severity}
                </span>
                <span className="flex-1 text-amber-900">{issue.message}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Approved video creatives ({videoCreatives.length})
        </h2>
        {videoCreatives.length === 0 ? (
          <p className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            No approved video creatives bundled with this launch yet.
          </p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-1 md:grid-cols-2">
            {videoCreatives.map((c) => {
              const captionedUrl = signedUrls[c.id] ?? null;
              const copies = copyByCreativeId[c.id] ?? [];
              const brollClips = Array.isArray(c.broll_clips) ? c.broll_clips : null;
              return (
                <li key={c.id} className="overflow-hidden rounded-md border bg-card shadow-sm">
                  <div className="aspect-video bg-black">
                    {captionedUrl ? (
                      <video
                        controls
                        playsInline
                        src={captionedUrl}
                        className="h-full w-full"
                        preload="metadata"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        no preview
                      </div>
                    )}
                  </div>
                  <div className="space-y-3 p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-base font-medium">v{c.version}</h3>
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
                        {c.duration_actual_s ?? brief.target_duration_s ?? "?"}s
                      </span>
                    </div>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <p>
                        <span className="font-medium text-foreground">Status:</span>{" "}
                        <span className="font-mono">{c.status}</span>
                      </p>
                      <p>
                        <span className="font-medium text-foreground">Drive:</span>{" "}
                        {c.drive_url ? (
                          <a
                            href={c.drive_url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="break-all underline-offset-4 hover:underline"
                          >
                            View in Drive
                          </a>
                        ) : (
                          <span className="text-rose-600">missing</span>
                        )}
                      </p>
                      {c.captioned_path ? (
                        <p>
                          <span className="font-medium text-foreground">Captioned path:</span>{" "}
                          <span className="break-all font-mono">{c.captioned_path}</span>
                        </p>
                      ) : (
                        <p className="text-rose-600">No captioned cut.</p>
                      )}
                    </div>

                    {brollClips && brollClips.length > 0 ? (
                      <div className="space-y-1 border-t pt-3 text-xs">
                        <p className="font-medium text-foreground">
                          B-roll ({brollClips.length} clip
                          {brollClips.length === 1 ? "" : "s"})
                        </p>
                        <ul className="space-y-0.5 text-muted-foreground">
                          {brollClips.slice(0, 5).map((clip, i) => {
                            const obj = clip as Record<string, unknown>;
                            const idx = obj.segment_idx ?? i;
                            const inS = obj.in_s ?? "?";
                            const outS = obj.out_s ?? "?";
                            const clipId = obj.clip_id ?? "?";
                            return (
                              <li key={i} className="font-mono">
                                #{String(idx)} · {String(clipId)} ({String(inS)}s–{String(outS)}s)
                              </li>
                            );
                          })}
                          {brollClips.length > 5 ? (
                            <li className="italic">+ {brollClips.length - 5} more…</li>
                          ) : null}
                        </ul>
                      </div>
                    ) : null}

                    {copies.length === 0 ? (
                      <p className="text-xs text-rose-600">No paired copy variants.</p>
                    ) : (
                      <ul className="space-y-2 border-t pt-3">
                        {copies.map((cv) => (
                          <li key={cv.id} className="space-y-0.5 text-xs">
                            {cv.headline ? <p className="font-semibold">{cv.headline}</p> : null}
                            {cv.body ? <p className="text-muted-foreground">{cv.body}</p> : null}
                            {cv.cta ? (
                              <p className="font-medium text-foreground">CTA: {cv.cta}</p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-2 rounded-md border bg-muted/20 p-4 text-xs text-muted-foreground">
        <h2 className="text-sm font-semibold text-foreground">Validation</h2>
        <p>
          Verdict via <span className="font-mono">{payload.validation.via}</span>:{" "}
          <span className={payload.validation.ok ? "text-emerald-700" : "text-rose-700"}>
            {payload.validation.ok ? "ok" : "issues present"}
          </span>
        </p>
        {payload.validation.raw_stderr ? (
          <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted p-2 text-xs">
            {payload.validation.raw_stderr}
          </pre>
        ) : null}
      </section>
    </section>
  );
}

function Field({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={className ?? "text-sm"}>{value}</dd>
    </div>
  );
}
