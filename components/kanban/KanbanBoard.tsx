"use client";

import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList, Film } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import {
  KANBAN_STAGES,
  STAGE_DOT_COLORS,
  STAGE_LABELS,
  type DashboardFormat,
  type DashboardImageBrief,
  type DashboardVideoBrief,
  type FunnelStage,
} from "@/lib/dashboard-types";
import { createRealtimeQueue } from "@/lib/realtime-queue";
import { useRealtimeStream } from "@/hooks/useRealtimeStream";

import { KanbanCard } from "./KanbanCard";
import { KanbanColumn } from "./KanbanColumn";

/**
 * Brief id → pipeline id map, pre-fetched by the dashboard server
 * component. When a brief was created via the Pipeline feature, the value
 * is the owning pipeline's id and the KanbanCard deep-links into
 * `/pipeline/[id]`; otherwise the card falls back to the standalone brief
 * page. See `lib/pipeline/lookup.ts`.
 *
 * Plain objects (not `Map`) because the props cross the server→client
 * boundary and Maps are not serializable across the RSC payload.
 */
export type BriefPipelineMap = Record<string, string>;

export type KanbanBoardProps = {
  format: DashboardFormat;
  imageBriefs: DashboardImageBrief[];
  videoBriefs: DashboardVideoBrief[];
  imagePipelineMap?: BriefPipelineMap;
  videoPipelineMap?: BriefPipelineMap;
};

/**
 * The Brief column (first in the lifecycle) is the only one with real data in
 * Wave 1. The downstream stages all map to placeholder columns that render
 * their header + an empty-state message, so the UI shape stays stable as
 * M2/M3/V2/V3 wire data in.
 *
 * `briefStages` lists every brief status that lands in the Brief column.
 */
const BRIEF_COLUMN_STATUSES = new Set(["draft", "posted", "approved", "approved_with_changes"]);

/**
 * Two-track Kanban board (image + video) wired to Supabase Realtime. When any
 * row on `briefs` or `video_briefs` changes we call `router.refresh()`, which
 * re-runs the server component on `/` and rehydrates the snapshot props.
 */
export function KanbanBoard({
  format,
  imageBriefs,
  videoBriefs,
  imagePipelineMap,
  videoPipelineMap,
}: KanbanBoardProps) {
  const router = useRouter();

  // Debounce realtime invalidations into a single 200ms batch. The Kanban
  // server component is expensive (it runs the dashboard aggregation query),
  // so a burst of brief writes from the worker shouldn't cascade into
  // multiple `router.refresh()` calls. The queue is owned by the component
  // and disposed on unmount.
  const queueRef = useRef(createRealtimeQueue());
  useEffect(() => {
    const queue = queueRef.current;
    return () => queue.dispose();
  }, []);

  useRealtimeStream(
    useMemo(
      () => [
        {
          table: "briefs",
          event: "*" as const,
          callback: () => queueRef.current.queue("briefs", () => router.refresh()),
        },
        {
          table: "video_briefs",
          event: "*" as const,
          callback: () => queueRef.current.queue("video_briefs", () => router.refresh()),
        },
      ],
      [router],
    ),
  );

  const renderImageTrack = format === "image" || format === "both";
  const renderVideoTrack = format === "video" || format === "both";

  return (
    <div className="flex flex-col gap-6">
      {renderImageTrack ? (
        <KanbanTrack
          title="Image briefs"
          accentClass="bg-violet-500"
          kind="image"
          briefs={imageBriefs}
          pipelineMap={imagePipelineMap}
        />
      ) : null}
      {renderVideoTrack ? (
        <KanbanTrack
          title="Video briefs"
          accentClass="bg-cyan-500"
          kind="video"
          briefs={videoBriefs}
          pipelineMap={videoPipelineMap}
        />
      ) : null}
    </div>
  );
}

type KanbanTrackProps =
  | {
      title: string;
      accentClass: string;
      kind: "image";
      briefs: DashboardImageBrief[];
      pipelineMap?: BriefPipelineMap;
    }
  | {
      title: string;
      accentClass: string;
      kind: "video";
      briefs: DashboardVideoBrief[];
      pipelineMap?: BriefPipelineMap;
    };

function KanbanTrack(props: KanbanTrackProps) {
  const { title, accentClass, kind, briefs, pipelineMap } = props;
  const briefColumn = briefs.filter((b) => BRIEF_COLUMN_STATUSES.has(b.status));
  const trackIsEmpty = briefs.length === 0;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${accentClass}`} />
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-muted-foreground">{briefs.length} active</span>
      </div>
      {trackIsEmpty ? (
        <EmptyState
          icon={
            kind === "image" ? (
              <ClipboardList className="h-8 w-8" aria-hidden="true" />
            ) : (
              <Film className="h-8 w-8" aria-hidden="true" />
            )
          }
          title={`No active ${kind} briefs`}
          description={
            kind === "image"
              ? "Create an image brief to populate the board."
              : "Create a video brief to populate the board."
          }
          action={{
            label: kind === "image" ? "New image brief" : "New video brief",
            href: kind === "image" ? "/briefs/new" : "/briefs/video/new",
          }}
        />
      ) : (
        <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:snap-none sm:gap-4 sm:px-0">
          {KANBAN_STAGES.map((stage: FunnelStage) => {
            const isBriefColumn = stage === "in_brief";
            const count = isBriefColumn ? briefColumn.length : 0;
            return (
              <KanbanColumn
                key={stage}
                title={STAGE_LABELS[stage]}
                count={count}
                accentClass={STAGE_DOT_COLORS[stage]}
                emptyMessage={
                  isBriefColumn ? "No briefs in this stage yet." : "Lands in a later milestone."
                }
              >
                {isBriefColumn
                  ? briefColumn.map((brief) =>
                      kind === "image" ? (
                        <KanbanCard
                          key={brief.id}
                          kind="image"
                          brief={brief as DashboardImageBrief}
                          pipelineId={pipelineMap?.[brief.id] ?? null}
                        />
                      ) : (
                        <KanbanCard
                          key={brief.id}
                          kind="video"
                          brief={brief as DashboardVideoBrief}
                          pipelineId={pipelineMap?.[brief.id] ?? null}
                        />
                      ),
                    )
                  : null}
              </KanbanColumn>
            );
          })}
        </div>
      )}
    </section>
  );
}
