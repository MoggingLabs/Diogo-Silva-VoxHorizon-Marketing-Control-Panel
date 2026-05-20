"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Film, ImageOff, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CostBreakdownTable } from "@/components/pipeline/CostBreakdownTable";
import { StageShell } from "@/components/pipeline/StageShell";
import type { Estimate } from "@/lib/cost-estimator";
import { CREATIVES_BUCKET as IMAGE_CREATIVES_BUCKET } from "@/lib/creatives";
import {
  CREATIVES_BUCKET as VIDEO_CREATIVES_BUCKET,
  DEFAULT_SIGNED_URL_TTL_S as VIDEO_SIGNED_URL_TTL_S,
} from "@/lib/video-creatives";
import { activeTracks } from "@/lib/pipeline/tracks";
import type { Pipeline } from "@/lib/pipeline/types";
import {
  fetchCreativesByBrief,
  fetchVideoCreativesByBrief,
  signStoragePaths,
} from "@/lib/realtime/client-data";
import { cn } from "@/lib/utils";

const IMAGE_SIGNED_URL_TTL_S = 3600;

export type StageDoneProps = {
  pipeline: Pipeline;
  /** Image brief id (FK from pipeline). Used to scope the final-creatives
   *  fetch — the component does its own data load against the public
   *  Supabase client to keep the page-level shape thin. */
  imageBriefId?: string | null;
  videoBriefId?: string | null;
};

/** A finished image creative grouped by `concept`. Each row carries the two
 *  ratios (1:1 + 9:16) the worker produces in the generation stage. */
type ImageFinalRow = {
  id: string;
  concept: string | null;
  ratio: string | null;
  version: string;
  file_path_supabase: string | null;
};

/** A finished video creative. `composed_path` / `captioned_path` are the
 *  two media artefacts; we render the captioned MP4 when present and fall
 *  back to the composed MP4 otherwise. The composed-frame `script_path`
 *  resolves a poster image when available. */
type VideoFinalRow = {
  id: string;
  status: string;
  composed_path: string | null;
  captioned_path: string | null;
  duration_actual_s: number | null;
};

/** Concept bucket — one entry per `concept` string, with the per-ratio
 *  creative rows nested inside. Used to render the gallery as one card
 *  per concept with both ratios side-by-side. */
type ConceptBucket = {
  concept: string;
  rows: ImageFinalRow[];
};

/**
 * Done-stage UI (PF-F-1).
 *
 * Terminal gallery + cost reconciliation + launch handoff. Renders only when
 * the pipeline has reached `done`; the orchestrator wires this in from the
 * detail page based on `pipeline.status`.
 *
 * Layout:
 *   - Per-track gallery section. For image tracks we group by `concept` so
 *     the 1:1 and 9:16 ratios sit side-by-side. For video tracks we show a
 *     poster + click-to-play tile per creative.
 *   - `<CostBreakdownTable />` in estimate-vs-actual mode — both sides come
 *     from `pipeline.cost_estimate` / `pipeline.cost_actual`. If the
 *     estimate snapshot is missing the table hides itself.
 *   - Primary CTA "Build launch package" → `/launches/new?pipeline_id={id}`
 *     when the pipeline isn't already linked. When `launch_package_id` is
 *     set the CTA flips to "View launch package" → `/launches/{id}`.
 *
 * Data fetch uses the public browser Supabase client (anon RLS is fine —
 * creatives + video_creatives are readable by authed operators). We filter
 * out ideation-stage drafts (image `version='v0.ideation'`) so only the
 * paid v1.x finals appear.
 */
export function StageDone({ pipeline, imageBriefId, videoBriefId }: StageDoneProps) {
  const router = useRouter();
  const tracks = useMemo(() => activeTracks(pipeline.format_choice), [pipeline.format_choice]);
  const imageActive = tracks.includes("image");
  const videoActive = tracks.includes("video");

  const estimate = useMemo(() => readEstimate(pipeline.cost_estimate), [pipeline.cost_estimate]);
  const actual = useMemo(() => readEstimate(pipeline.cost_actual), [pipeline.cost_actual]);

  const handleBuildLaunch = () => {
    router.push(`/launches/new?pipeline_id=${pipeline.id}`);
  };
  const handleViewLaunch = () => {
    if (!pipeline.launch_package_id) return;
    router.push(`/launches/${pipeline.launch_package_id}`);
  };

  return (
    <StageShell
      title="All done — your creatives are ready"
      subtitle="Review the finals, reconcile costs, then build the launch package."
      // No bottom-bar Continue CTA on the Done stage — the launch action
      // lives in the body so it sits next to the gallery and cost table.
      canContinue={false}
      body={
        <div className="flex flex-col gap-6">
          {imageActive ? <ImageGallerySection briefId={imageBriefId ?? null} /> : null}
          {videoActive ? <VideoGallerySection briefId={videoBriefId ?? null} /> : null}

          {estimate ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Cost — forecast vs actual</h3>
              <CostBreakdownTable
                estimate={estimate}
                actual={actual ?? undefined}
                emptyMessage="No costs recorded for this pipeline."
              />
            </section>
          ) : null}

          <section className="flex flex-col gap-2 rounded-md border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <h3 className="text-base font-semibold">Launch package</h3>
              <p className="text-sm text-muted-foreground">
                {pipeline.launch_package_id
                  ? "This pipeline is linked to a launch package."
                  : "Build the launch bundle from the finals above."}
              </p>
            </div>
            {pipeline.launch_package_id ? (
              <Button type="button" onClick={handleViewLaunch} className="min-h-11">
                View launch package
              </Button>
            ) : (
              <Button type="button" onClick={handleBuildLaunch} className="min-h-11">
                Build launch package
              </Button>
            )}
          </section>
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Cost JSON → Estimate parse
// ---------------------------------------------------------------------------

/**
 * Coerce the loose jsonb `cost_estimate` / `cost_actual` columns into the
 * shape `<CostBreakdownTable />` expects. Returns `null` on a missing /
 * malformed snapshot — the table gates on `estimate` being non-null.
 */
function readEstimate(raw: Pipeline["cost_estimate"] | Pipeline["cost_actual"]): Estimate | null {
  if (!raw) return null;
  // Trust the shape: the snapshot is the same Estimate this app writes.
  // Cast carefully — `items` and `total` are the only fields we touch.
  const candidate = raw as { items?: unknown; total?: unknown };
  if (!Array.isArray(candidate.items) || typeof candidate.total !== "number") {
    return null;
  }
  return raw as unknown as Estimate;
}

// ---------------------------------------------------------------------------
// Image gallery — one card per concept, both ratios side-by-side.
// ---------------------------------------------------------------------------

function ImageGallerySection({ briefId }: { briefId: string | null }) {
  const [buckets, setBuckets] = useState<ConceptBucket[] | null>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!briefId) {
      setBuckets([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Only the v1.x finals. The ideation stage stamps `v0.ideation` on
        // its cheap drafts; production stage writes `v1.0`, `v1.1`, …  We
        // fetch the brief's creatives via the service-role API and drop the
        // ideation drafts client-side.
        const all = await fetchCreativesByBrief<ImageFinalRow>(briefId);
        if (cancelled) return;
        const rows = all.filter((r) => r.version !== "v0.ideation");
        const grouped = groupByConcept(rows);
        setBuckets(grouped);

        // Resolve signed URLs for every row that has a stored file in one
        // batched server round-trip; failures leave the row's URL as `null`.
        const flatRows = grouped.flatMap((b) => b.rows);
        const paths = flatRows
          .map((r) => r.file_path_supabase)
          .filter((p): p is string => typeof p === "string" && p.length > 0);
        if (paths.length > 0) {
          const urls = await signStoragePaths(
            IMAGE_CREATIVES_BUCKET,
            paths,
            IMAGE_SIGNED_URL_TTL_S,
          );
          if (cancelled) return;
          setSignedUrls((prev) => {
            const next = { ...prev };
            for (const row of flatRows) {
              if (row.file_path_supabase) {
                next[row.id] = urls[row.file_path_supabase] ?? null;
              }
            }
            return next;
          });
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setBuckets([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [briefId]);

  return (
    <GallerySection
      label="Image finals"
      empty={
        buckets === null
          ? null
          : buckets.length === 0
            ? "No final images recorded for this pipeline."
            : null
      }
      error={error}
    >
      {buckets === null ? <ImageSkeleton /> : null}
      {buckets && buckets.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {buckets.map((b) => (
            <li
              key={b.concept}
              className="flex flex-col gap-2 overflow-hidden rounded-md border bg-card p-3 shadow-sm"
            >
              <div className="space-y-0.5">
                <p className="truncate text-sm font-medium text-foreground" title={b.concept}>
                  {b.concept || "Untitled"}
                </p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {b.rows.length} {b.rows.length === 1 ? "ratio" : "ratios"}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {b.rows.map((row) => (
                  <figure
                    key={row.id}
                    className="flex flex-col gap-1 overflow-hidden rounded border bg-muted/30"
                  >
                    <div
                      className={cn(
                        "relative w-full overflow-hidden bg-muted/40",
                        row.ratio === "9x16"
                          ? "aspect-[9/16]"
                          : row.ratio === "16x9"
                            ? "aspect-[16/9]"
                            : "aspect-square",
                      )}
                    >
                      {signedUrls[row.id] ? (
                        // eslint-disable-next-line @next/next/no-img-element -- signed URL from Supabase Storage requires a plain <img>
                        <img
                          src={signedUrls[row.id] ?? undefined}
                          alt={`${b.concept || "Final"} – ${row.ratio ?? "ratio unknown"}`}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                          <ImageOff aria-hidden="true" className="h-5 w-5" />
                          <span className="text-[10px]">No render</span>
                        </div>
                      )}
                    </div>
                    <figcaption className="px-2 pb-1 font-mono text-[10px] text-muted-foreground">
                      {row.ratio ?? "—"}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </GallerySection>
  );
}

function groupByConcept(rows: ImageFinalRow[]): ConceptBucket[] {
  const byConcept = new Map<string, ImageFinalRow[]>();
  for (const r of rows) {
    const key = (r.concept ?? "").trim() || "Untitled";
    const list = byConcept.get(key) ?? [];
    list.push(r);
    byConcept.set(key, list);
  }
  // Sort each bucket by ratio for a stable 1x1 → 9x16 → 16x9 read order.
  const ratioOrder: Record<string, number> = { "1x1": 0, "9x16": 1, "16x9": 2 };
  const buckets: ConceptBucket[] = [];
  for (const [concept, list] of byConcept.entries()) {
    list.sort((a, b) => (ratioOrder[a.ratio ?? ""] ?? 99) - (ratioOrder[b.ratio ?? ""] ?? 99));
    buckets.push({ concept, rows: list });
  }
  // Keep concept order stable across renders.
  buckets.sort((a, b) => a.concept.localeCompare(b.concept));
  return buckets;
}

// ---------------------------------------------------------------------------
// Video gallery — poster + click-to-play per captioned MP4.
// ---------------------------------------------------------------------------

function VideoGallerySection({ briefId }: { briefId: string | null }) {
  const [rows, setRows] = useState<VideoFinalRow[] | null>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string | null>>({});
  const [playing, setPlaying] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!briefId) {
      setRows([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Compose-complete + caption-complete creatives are the ones we
        // show. The state machine guarantees that a row reaches `captioned`
        // only after `composed`, and `approved` only after `captioned` —
        // including all three keeps the gallery resilient to the operator
        // manually re-approving a creative. We fetch the brief's video
        // creatives via the service-role API and filter status client-side.
        const all = await fetchVideoCreativesByBrief<VideoFinalRow>(briefId);
        if (cancelled) return;
        const fetched = all.filter(
          (r) => r.status === "composed" || r.status === "captioned" || r.status === "approved",
        );
        setRows(fetched);

        // Prefer the captioned MP4 when present — the captioning step is the
        // final transform. Falling back to composed gives operators a preview
        // even before captioning finishes. One batched server round-trip.
        const pathByRow = new Map<string, string>();
        for (const row of fetched) {
          const path = row.captioned_path ?? row.composed_path;
          if (path) pathByRow.set(row.id, path);
        }
        const paths = Array.from(new Set(pathByRow.values()));
        if (paths.length > 0) {
          const urls = await signStoragePaths(
            VIDEO_CREATIVES_BUCKET,
            paths,
            VIDEO_SIGNED_URL_TTL_S,
          );
          if (cancelled) return;
          setSignedUrls((prev) => {
            const next = { ...prev };
            for (const [rowId, path] of pathByRow) {
              next[rowId] = urls[path] ?? null;
            }
            return next;
          });
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [briefId]);

  return (
    <GallerySection
      label="Video finals"
      empty={
        rows === null
          ? null
          : rows.length === 0
            ? "No final videos recorded for this pipeline."
            : null
      }
      error={error}
    >
      {rows === null ? <ImageSkeleton /> : null}
      {rows && rows.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => {
            const src = signedUrls[row.id] ?? null;
            const isPlaying = playing[row.id] ?? false;
            const duration =
              typeof row.duration_actual_s === "number" && row.duration_actual_s > 0
                ? `${row.duration_actual_s}s`
                : "duration TBD";

            return (
              <li
                key={row.id}
                className="flex flex-col gap-2 overflow-hidden rounded-md border bg-card p-3 shadow-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <Film className="h-3.5 w-3.5" aria-hidden="true" />
                    {row.status}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">{duration}</span>
                </div>
                <div className="relative aspect-[9/16] overflow-hidden rounded bg-muted/40">
                  {isPlaying && src ? (
                    <video
                      src={src}
                      controls
                      autoPlay
                      playsInline
                      className="h-full w-full bg-black object-contain"
                    >
                      <track kind="captions" />
                    </video>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        if (!src) return;
                        setPlaying((p) => ({ ...p, [row.id]: true }));
                      }}
                      disabled={!src}
                      aria-label="Play video"
                      className={cn(
                        "group relative flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground",
                        !src && "cursor-not-allowed",
                      )}
                    >
                      <Play
                        aria-hidden="true"
                        className="h-10 w-10 transition-transform group-hover:scale-110"
                      />
                      <span className="text-xs">{src ? "Play" : "No render"}</span>
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </GallerySection>
  );
}

// ---------------------------------------------------------------------------
// Shared shell for both gallery sections — keeps headings + error / empty
// states consistent across image/video.
// ---------------------------------------------------------------------------

function GallerySection({
  label,
  empty,
  error,
  children,
}: {
  label: string;
  empty: string | null;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{label}</h3>
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Failed to load: {error}
        </div>
      ) : null}
      {empty ? (
        <div className="rounded-md border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
          {empty}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function ImageSkeleton() {
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, idx) => (
        <li
          key={idx}
          className="flex animate-pulse flex-col gap-2 overflow-hidden rounded-md border bg-card p-3"
        >
          <div className="h-3 w-3/4 rounded bg-muted/60" />
          <div className="grid grid-cols-2 gap-2">
            <div className="aspect-square w-full rounded bg-muted/50" />
            <div className="aspect-[9/16] w-full rounded bg-muted/50" />
          </div>
        </li>
      ))}
    </ul>
  );
}
