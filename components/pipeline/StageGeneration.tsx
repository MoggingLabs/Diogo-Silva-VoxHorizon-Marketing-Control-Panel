"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  RotateCw,
  Sparkles,
  Video as VideoIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { StageShell } from "@/components/pipeline/StageShell";
import { usePipelineEvents } from "@/hooks/usePipelineEvents";
import { CREATIVES_BUCKET } from "@/lib/creatives";
import {
  collapseGenerationTasks,
  readCostTotal,
  type GenerationTask,
} from "@/lib/pipeline/generation-tasks";
import type { Pipeline, PipelineEvent } from "@/lib/pipeline/types";
import { signStoragePath } from "@/lib/realtime/client-data";
import { cn } from "@/lib/utils";

const POLL_COST_REFRESH_MS = 4_000;

export type StageGenerationProps = {
  pipeline: Pipeline;
  /**
   * Server-fetched pipeline_events snapshot. `usePipelineEvents` seeds
   * its state from this list and folds in new rows via realtime.
   */
  initialEvents: PipelineEvent[];
};

/**
 * Generation stage UI (PF-E-2 / #194).
 *
 * Shows the live task list for a pipeline in `status='generation'`. Each
 * task lifecycle (queued → running → done | error) collapses into a
 * single row so the operator sees N rows for N tasks — not 3N events.
 *
 * Layout:
 *   - Header strip with the running cost (`pipeline.cost_actual.total`)
 *     and a banner explaining the auto-advance behaviour (no Continue
 *     button — the DB trigger flips the pipeline forward when the last
 *     task closes; see PF-E-5).
 *   - Vertical list of task rows. Each row carries:
 *       * a status badge (queued / running / done / error)
 *       * a human-readable label derived from the task payload
 *       * a thumbnail (image picks) or artifact link (video picks)
 *         once the task is done
 *       * a "Retry" button on error rows → POST /api/.../tasks/.../retry
 *
 * Data sources:
 *   - `usePipelineEvents(pipeline.id, initialEvents)` for the timeline.
 *   - A Supabase Realtime subscription on `pipelines` (id-filtered) is
 *     handled at the parent `<PipelineDetailRealtime />`; the running
 *     cost re-renders via `router.refresh()` from that hook. We also
 *     poll `pipelines.cost_actual` every few seconds as a belt-and-
 *     braces fallback in case the realtime subscription drops.
 *
 * Mobile: rows stack with smaller text; thumbnails clip to a fixed
 * 56-by-56 box so a long video filename can't push the row off-screen.
 */
export function StageGeneration({ pipeline, initialEvents }: StageGenerationProps) {
  const events = usePipelineEvents(pipeline.id, initialEvents);
  const router = useRouter();

  // The parent realtime hook re-renders us on every `pipelines` row
  // change so `pipeline.cost_actual` is always fresh; a low-cadence
  // poll covers brief disconnects (e.g. a tab in the background that
  // missed a few realtime frames).
  useEffect(() => {
    if (pipeline.status !== "generation") return;
    const handle = setInterval(() => {
      router.refresh();
    }, POLL_COST_REFRESH_MS);
    return () => clearInterval(handle);
  }, [pipeline.status, router]);

  const tasks = useMemo(() => collapseGenerationTasks(events), [events]);
  const completedCount = tasks.filter((t) => t.status === "done").length;
  const erroredCount = tasks.filter((t) => t.status === "error").length;
  const runningCount = tasks.filter((t) => t.status === "running" || t.status === "queued").length;

  const totalCost = readCostTotal(pipeline.cost_actual);

  return (
    <StageShell
      title="Generation"
      subtitle={summary({
        completedCount,
        erroredCount,
        runningCount,
        totalCount: tasks.length,
      })}
      // No Continue button — the auto-advance trigger flips the
      // pipeline forward on the DB side (PF-E-5).
      canContinue={false}
      body={
        <div className="flex flex-col gap-5">
          <CostHeader totalCost={totalCost} pipelineStatus={pipeline.status} />
          {tasks.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border bg-card">
              {tasks.map((task) => (
                <li key={task.taskKey}>
                  <TaskRow pipelineId={pipeline.id} task={task} />
                </li>
              ))}
            </ul>
          )}
        </div>
      }
      // Custom footer message — `StageShell` always renders a CTA, so
      // we slot the auto-advance hint into `secondaryAction` and keep
      // `canContinue={false}` so the disabled CTA stays hidden behind
      // its standard styling.
    />
  );
}

// ---------------------------------------------------------------------------
// Header — running cost.
// ---------------------------------------------------------------------------

function CostHeader({
  totalCost,
  pipelineStatus,
}: {
  totalCost: number;
  pipelineStatus: Pipeline["status"];
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Cost so far</span>
        <span className="font-mono text-2xl font-semibold text-foreground">
          ${totalCost.toFixed(2)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground sm:max-w-sm sm:text-right">
        {pipelineStatus === "done"
          ? "Generation complete — pipeline auto-advanced to Done. Final renders are ready below."
          : "Generation runs in the background. This page advances automatically once every task closes."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task row.
// ---------------------------------------------------------------------------

function TaskRow({ pipelineId, task }: { pipelineId: string; task: GenerationTask }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <ThumbnailOrIcon task={task} />
      <div className="flex flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={task.status} />
          {task.isRetry ? (
            <span
              aria-label="Retry attempt"
              className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
            >
              <RotateCw aria-hidden="true" className="h-3 w-3" /> Retry
            </span>
          ) : null}
          <span className="text-sm font-medium text-foreground" title={task.label}>
            {task.label}
          </span>
        </div>
        <TaskMeta task={task} />
      </div>
      <div className="flex items-center gap-2 sm:self-center">
        <ArtifactLink task={task} />
        {task.status === "error" && task.errorEventId ? (
          <RetryButton pipelineId={pipelineId} taskEventId={task.errorEventId} />
        ) : null}
      </div>
    </div>
  );
}

function TaskMeta({ task }: { task: GenerationTask }) {
  const payload = (task.latest.payload ?? {}) as Record<string, unknown>;
  // Errors get the worker's truncated message; running/done rows get a
  // monospace creative_id when present (helpful when debugging which
  // row is which).
  if (task.status === "error") {
    const errMsg = typeof payload.error === "string" ? payload.error : "Task failed";
    return (
      <p className="line-clamp-2 text-xs text-destructive" title={errMsg}>
        {errMsg}
      </p>
    );
  }
  const creativeId = typeof payload.creative_id === "string" ? payload.creative_id : "";
  if (creativeId) {
    return (
      <p className="font-mono text-[11px] text-muted-foreground" title={creativeId}>
        {creativeId.slice(0, 8)}…
      </p>
    );
  }
  return null;
}

function ThumbnailOrIcon({ task }: { task: GenerationTask }) {
  const filePath =
    task.donePayload && typeof task.donePayload.file_path_supabase === "string"
      ? task.donePayload.file_path_supabase
      : null;
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath || task.kind !== "image") {
      setThumb(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const signedUrl = await signStoragePath(CREATIVES_BUCKET, filePath, 3600);
      if (cancelled) return;
      setThumb(signedUrl);
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath, task.kind]);

  if (task.kind === "image" && thumb) {
    return (
      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md border bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- signed URLs from Supabase Storage need a plain <img> */}
        <img src={thumb} alt={task.label} className="h-full w-full object-cover" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex h-14 w-14 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground",
      )}
      aria-hidden="true"
    >
      {task.kind === "video" ? (
        <VideoIcon className="h-5 w-5" />
      ) : (
        <ImageIcon className="h-5 w-5" />
      )}
    </div>
  );
}

function ArtifactLink({ task }: { task: GenerationTask }) {
  if (task.status !== "done" || !task.donePayload) return null;
  // Video tasks emit one of `composed_path` / `captioned_path` /
  // `voiceover_path` / `script_path` depending on the substage. Pick
  // the most-downstream artifact present so the link is most useful.
  const path = pickVideoArtifactPath(task.donePayload);
  if (!path) return null;
  // We don't sign the URL up front (server-side render) — render a
  // button-flavoured link that fires a fresh signed URL on click.
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="min-h-9 gap-1.5"
      onClick={() => {
        void openSignedUrl(path);
      }}
    >
      <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
      Open
    </Button>
  );
}

function pickVideoArtifactPath(payload: Record<string, unknown>): string | null {
  for (const key of ["captioned_path", "composed_path", "voiceover_path", "script_path"] as const) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

async function openSignedUrl(path: string): Promise<void> {
  const signedUrl = await signStoragePath(CREATIVES_BUCKET, path, 3600);
  if (!signedUrl) {
    console.warn(`[StageGeneration] could not sign artifact url for ${path}`);
    return;
  }
  window.open(signedUrl, "_blank", "noopener,noreferrer");
}

// ---------------------------------------------------------------------------
// Retry button.
// ---------------------------------------------------------------------------

function RetryButton({ pipelineId, taskEventId }: { pipelineId: string; taskEventId: string }) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/pipelines/${encodeURIComponent(pipelineId)}/tasks/${encodeURIComponent(taskEventId)}/retry`,
        { method: "POST", cache: "no-store" },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text.slice(0, 200) || `retry failed (${res.status})`);
      }
      // The retry endpoint emits a fresh task_queued event; the realtime
      // hook surfaces it as a new row. We keep the button disabled
      // briefly so a double-click doesn't fire two retries.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // Brief debounce — the retry chain takes time and the new row
      // will appear shortly via realtime.
      setTimeout(() => setRetrying(false), 1500);
    }
  }, [pipelineId, retrying, taskEventId]);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-9 gap-1.5"
        disabled={retrying}
        onClick={onClick}
        aria-label="Retry this task"
      >
        <RotateCw aria-hidden="true" className={cn("h-3.5 w-3.5", retrying && "animate-spin")} />
        {retrying ? "Retrying…" : "Retry"}
      </Button>
      {error ? (
        <span role="alert" className="max-w-[16rem] text-right text-[11px] text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state — no task events yet.
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/30 px-6 py-12 text-center"
    >
      <div className="relative">
        <Sparkles aria-hidden="true" className="h-7 w-7 text-muted-foreground" />
        <Loader2
          aria-hidden="true"
          className="absolute -right-1 -top-1 h-4 w-4 animate-spin text-muted-foreground"
        />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Generation is starting…</p>
        <p className="text-xs text-muted-foreground">
          Tasks will appear here as the worker kicks off each render.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Misc.
// ---------------------------------------------------------------------------

function summary({
  completedCount,
  erroredCount,
  runningCount,
  totalCount,
}: {
  completedCount: number;
  erroredCount: number;
  runningCount: number;
  totalCount: number;
}): string {
  if (totalCount === 0) {
    return "Worker is queuing the first batch of renders. Tasks will stream in here.";
  }
  const parts: string[] = [`${completedCount}/${totalCount} done`];
  if (runningCount > 0) parts.push(`${runningCount} in flight`);
  if (erroredCount > 0) parts.push(`${erroredCount} failed`);
  return parts.join(" · ");
}
