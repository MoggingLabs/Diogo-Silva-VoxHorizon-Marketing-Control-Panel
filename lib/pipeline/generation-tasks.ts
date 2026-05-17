/**
 * Pure helpers for the StageGeneration UI (PF-E-2 / #194).
 *
 * The component collapses the raw `pipeline_events` timeline into one
 * row per task lifecycle (queued → running → done | error) and the
 * grouping rules are non-trivial. Extracting them here keeps the
 * component thin and lets the rules be unit-tested without React.
 */

import type { PipelineEvent } from "@/lib/pipeline/types";

export type GenerationTaskStatus = "queued" | "running" | "done" | "error";

export type GenerationTask = {
  /** Stable key for React + retry correlation. */
  taskKey: string;
  /** Latest status in the chain. */
  status: GenerationTaskStatus;
  /** Image vs video, for the icon. */
  kind: "image" | "video" | "unknown";
  /** Pre-computed display label for the row. */
  label: string;
  /** The event row of the latest state. */
  latest: PipelineEvent;
  /** Source `task_error` event id, present when status === "error".
   *  The retry endpoint takes this id. */
  errorEventId: string | null;
  /** Latest `task_done` event payload, for thumbnails / artifact
   *  links. Null until the task completes. */
  donePayload: Record<string, unknown> | null;
  /** Whether this row represents a retry of an earlier task (i.e. the
   *  first event in its chain carried `retry_of`). */
  isRetry: boolean;
};

const TASK_KINDS = new Set(["task_queued", "task_running", "task_done", "task_error"]);

const VIDEO_SUBSTAGE_LABEL: Record<string, string> = {
  script: "Script",
  voiceover: "Voiceover (ElevenLabs)",
  broll_search: "B-roll search",
  broll_pick: "B-roll selection",
  compose: "Compose (Hyperframes)",
  caption: "Captions (Submagic)",
};

/**
 * Group `pipeline_events` into one task per row. Returns tasks in
 * first-seen order (the events list is expected to be chronological).
 */
export function collapseGenerationTasks(events: PipelineEvent[]): GenerationTask[] {
  const tasks = new Map<string, GenerationTask>();
  const orderKeys: string[] = [];

  for (const ev of events) {
    if (!TASK_KINDS.has(ev.kind)) continue;
    if (ev.stage !== "generation") continue;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const key = taskKeyFromPayload(payload, ev);
    if (!key) continue;

    const existing = tasks.get(key);
    if (!existing) {
      tasks.set(key, newTaskFromEvent(key, ev, payload));
      orderKeys.push(key);
      continue;
    }
    mergeEventIntoTask(existing, ev, payload);
  }

  return orderKeys.map((k) => tasks.get(k)!).filter(Boolean);
}

/**
 * Stable key per task. Mirrors the worker's grouping in
 * `worker/src/routes/pipeline.py::_produce_generation_*`:
 *
 *   image: parent_creative_id + ratio (each pick produces 1:1 + 9:16)
 *   video: creative_id + substage   (one row per substage chain step)
 *
 * Retry events carry `retry_of` — we treat them as a distinct task so
 * the original error row stays visible alongside the new chain.
 */
export function taskKeyFromPayload(
  payload: Record<string, unknown>,
  ev: PipelineEvent,
): string | null {
  const kind = typeof payload.kind === "string" ? payload.kind : null;
  const retryOf =
    typeof payload.retry_of === "string" && payload.retry_of.length > 0 ? payload.retry_of : "";
  const retrySuffix = retryOf ? `:retry:${retryOf}` : "";
  if (kind === "image") {
    const parent = typeof payload.parent_creative_id === "string" ? payload.parent_creative_id : "";
    const ratio = typeof payload.ratio === "string" ? payload.ratio : "";
    if (!parent || !ratio) return null;
    return `image:${parent}:${ratio}${retrySuffix}`;
  }
  if (kind === "video") {
    const creativeId = typeof payload.creative_id === "string" ? payload.creative_id : "";
    const substage = typeof payload.substage === "string" ? payload.substage : "";
    if (!creativeId || !substage) return null;
    return `video:${creativeId}:${substage}${retrySuffix}`;
  }
  // Fall back to event id so a malformed payload still produces *some*
  // row rather than silently disappearing.
  return `event:${ev.id}`;
}

function newTaskFromEvent(
  key: string,
  ev: PipelineEvent,
  payload: Record<string, unknown>,
): GenerationTask {
  const kind = readKind(payload);
  return {
    taskKey: key,
    status: statusFromKind(ev.kind),
    kind,
    label: labelFor(kind, payload),
    latest: ev,
    errorEventId: ev.kind === "task_error" ? ev.id : null,
    donePayload: ev.kind === "task_done" ? payload : null,
    isRetry: typeof payload.retry_of === "string" && payload.retry_of.length > 0,
  };
}

function mergeEventIntoTask(
  task: GenerationTask,
  ev: PipelineEvent,
  payload: Record<string, unknown>,
): void {
  // Status precedence: the latest event chronologically is the source
  // of truth. A done after error is the operator winning a retry; the
  // events list is chronological so this naturally falls out.
  task.status = statusFromKind(ev.kind);
  task.latest = ev;
  if (ev.kind === "task_done") {
    task.donePayload = payload;
    task.errorEventId = null;
  } else if (ev.kind === "task_error") {
    task.errorEventId = ev.id;
  }
  // Refresh the label when the payload carries new info — e.g.
  // `task_done` events fill in `creative_id` we didn't have at queued.
  const refreshed = labelFor(task.kind, payload);
  if (refreshed) task.label = refreshed;
}

function readKind(payload: Record<string, unknown>): GenerationTask["kind"] {
  const v = typeof payload.kind === "string" ? payload.kind : null;
  if (v === "image" || v === "video") return v;
  return "unknown";
}

export function statusFromKind(kind: string): GenerationTaskStatus {
  if (kind === "task_done") return "done";
  if (kind === "task_error") return "error";
  if (kind === "task_running") return "running";
  return "queued";
}

export function labelFor(kind: GenerationTask["kind"], payload: Record<string, unknown>): string {
  if (kind === "image") {
    const concept = typeof payload.concept === "string" ? payload.concept : "";
    const ratio = typeof payload.ratio === "string" ? payload.ratio : "";
    const conceptLabel = concept.trim().length > 0 ? concept.trim() : "Concept";
    const ratioLabel = ratio ? ` (${ratio})` : "";
    return `Image render: ${conceptLabel}${ratioLabel}`;
  }
  if (kind === "video") {
    const substage = typeof payload.substage === "string" ? payload.substage : "";
    return `Video · ${prettySubstage(substage)}`;
  }
  return "Task";
}

export function prettySubstage(substage: string): string {
  if (!substage) return "Substage";
  return VIDEO_SUBSTAGE_LABEL[substage] ?? substage;
}

/**
 * Pull `cost_actual.total` defensively. The trigger writes a numeric,
 * but a hand-edited row could be a string; coerce + clamp to 0.
 */
export function readCostTotal(costActual: unknown): number {
  if (!costActual || typeof costActual !== "object") return 0;
  const total = (costActual as { total?: unknown }).total;
  if (typeof total === "number" && Number.isFinite(total)) return Math.max(0, total);
  if (typeof total === "string") {
    const parsed = Number.parseFloat(total);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}
