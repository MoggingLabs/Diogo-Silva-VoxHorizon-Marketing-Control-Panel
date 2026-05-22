/**
 * Thin fetch wrappers around the `/api/pipelines` routes Agent A is shipping
 * in parallel. Keeping the network code out of the UI components keeps them
 * testable and lets us swap to a typed client (or tRPC) later without
 * touching the call sites.
 */
import type { Pipeline, PipelineEvent, PipelineFormat, PipelineStatus } from "@/lib/pipeline/types";

export type CreatePipelineInput = {
  format_choice: PipelineFormat;
  client_id?: string;
};

export type ListPipelinesFilters = {
  status?: PipelineStatus;
  client_id?: string;
  limit?: number;
  cursor?: string;
};

export type ListPipelinesResult = {
  pipelines: Pipeline[];
  next_cursor: string | null;
};

export type GetPipelineResult = {
  pipeline: Pipeline;
  image_brief: unknown;
  video_brief: unknown;
  events: PipelineEvent[];
};

/**
 * Resolves the base URL used by server-side `fetch` calls. In the browser we
 * can use relative paths; in a Server Component we need an absolute URL.
 */
function resolveBaseUrl(): string {
  if (typeof window !== "undefined") return "";
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from ${res.url}: ${text.slice(0, 200)}`);
  }
}

export async function createPipeline(input: CreatePipelineInput): Promise<Pipeline> {
  const res = await fetch(`${resolveBaseUrl()}/api/pipelines`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `POST /api/pipelines failed (${res.status}): ${body.slice(0, 200) || res.statusText}`,
    );
  }
  const data = await readJson<{ pipeline: Pipeline }>(res);
  return data.pipeline;
}

/**
 * The "Finals model" picker options, in display order. Labels mirror
 * `FINALS_MODELS` in `app/api/pipelines/operator/route.ts` and
 * `ekko-skills/pipeline-operator/helper.py`. `cost` is the per-image cue shown
 * in the dropdown so the manager sees free vs paid at a glance. The first entry
 * (free codex) is the default. Ideation always renders free regardless of this.
 */
export const FINALS_MODEL_OPTIONS: ReadonlyArray<{ label: string; cost: string }> = [
  { label: "gpt-image-2 (free)", cost: "Free" },
  { label: "nano-banana-2", cost: "≈$0.05/img" },
  { label: "Flux", cost: "≈$0.05/img" },
  { label: "Seedream", cost: "≈$0.03/img" },
];

export const DEFAULT_FINALS_MODEL_LABEL = "gpt-image-2 (free)";

/**
 * Input to `POST /api/pipelines/operator` — the operator-driven kickoff.
 * `instruction` is the manager's free-text brief ("4 roofing ads, Austin,
 * $99 inspection"); the other fields mirror `CreatePipelineInput`.
 */
export type KickoffOperatorInput = {
  instruction: string;
  format_choice?: PipelineFormat;
  client_id?: string;
  /**
   * The manager's "Finals model" label for the generation stage. One of the
   * labels in `FINALS_MODEL_OPTIONS`; defaults server-side to the free
   * `gpt-image-2 (free)`. Ideation always renders free regardless of this.
   */
  finals_model?: string;
};

/**
 * Start an operator-driven pipeline: creates the pipeline row and nudges the
 * Hermes operator to begin authoring the brief. Returns the created pipeline
 * so the kickoff UI can redirect to its detail page. Throws on 4xx/5xx with
 * the inline error body for the caller to surface.
 */
export async function kickoffOperatorPipeline(input: KickoffOperatorInput): Promise<Pipeline> {
  const res = await fetch(`${resolveBaseUrl()}/api/pipelines/operator`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `POST /api/pipelines/operator failed (${res.status}): ${body.slice(0, 200) || res.statusText}`,
    );
  }
  const data = await readJson<{ pipeline: Pipeline }>(res);
  return data.pipeline;
}

export async function listPipelines(
  filters: ListPipelinesFilters = {},
): Promise<ListPipelinesResult> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.client_id) params.set("client_id", filters.client_id);
  if (typeof filters.limit === "number") params.set("limit", String(filters.limit));
  if (filters.cursor) params.set("cursor", filters.cursor);

  const qs = params.toString();
  const url = `${resolveBaseUrl()}/api/pipelines${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GET /api/pipelines failed (${res.status}): ${body.slice(0, 200) || res.statusText}`,
    );
  }
  return readJson<ListPipelinesResult>(res);
}

export async function getPipeline(id: string): Promise<GetPipelineResult> {
  const res = await fetch(`${resolveBaseUrl()}/api/pipelines/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (res.status === 404) {
    throw Object.assign(new Error("Pipeline not found"), { status: 404 });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GET /api/pipelines/${id} failed (${res.status}): ${body.slice(0, 200) || res.statusText}`,
    );
  }
  return readJson<GetPipelineResult>(res);
}

/**
 * Persists the operator's per-track pick selection for the ideation stage.
 *
 * The request overwrites the per-track arrays present in `picks` (so
 * deselecting works naturally), while tracks not present in the body are
 * left untouched on the server side. Throws on 4xx/5xx with the response
 * body inlined for the caller to surface — the `StageIdeation` UI uses
 * the error message in a toast / inline banner.
 */
export async function updatePicks(
  id: string,
  picks: { image?: string[]; video?: string[] },
): Promise<void> {
  const res = await fetch(`${resolveBaseUrl()}/api/pipelines/${encodeURIComponent(id)}/picks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(picks),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `POST /api/pipelines/${id}/picks failed (${res.status}): ${body.slice(0, 200) || res.statusText}`,
    );
  }
}

/**
 * Body shape for `POST /api/launches` when handing off from a pipeline.
 *
 * The launch route accepts the same shape with or without `pipeline_id`;
 * passing it triggers the back-link side effects (pipeline.launch_package_id
 * UPDATE + pipeline_events row) and a 422 if the pipeline isn't in `done`.
 */
export type LaunchFromPipelineInput = {
  brief_id: string;
  pipeline_id?: string;
};

/**
 * Light-weight launch row returned by `POST /api/launches`. We only need
 * the id for the post-create redirect — the launch detail page does its
 * own deeper fetch.
 */
export type LaunchCreated = { id: string };

/**
 * Build a launch package — `pipeline_id` is the optional pipeline handoff.
 *
 * Throws on 4xx/5xx with the error body inlined. The launch route returns
 * 201 on a clean posted package, 422 on validation issues (in which case
 * the response body contains an `error` + a `launch` row in `failed`
 * status). Callers should surface the message and let the operator decide
 * whether to retry.
 */
export async function createLaunchPackage(input: LaunchFromPipelineInput): Promise<LaunchCreated> {
  const res = await fetch(`${resolveBaseUrl()}/api/launches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `POST /api/launches failed (${res.status}): ${body.slice(0, 200) || res.statusText}`,
    );
  }
  const data = await readJson<{ launch: LaunchCreated }>(res);
  return data.launch;
}

/**
 * Cancel an in-flight pipeline. Flips the pipeline to `status='cancelled'`
 * from any non-terminal stage (configuration / ideation / review / generation).
 * Throws on 4xx/5xx with the inline error body — UI surfaces should display
 * the message and let the operator decide whether to retry.
 */
export async function cancelPipeline(id: string): Promise<{ pipeline: Pipeline }> {
  const res = await fetch(`${resolveBaseUrl()}/api/pipelines/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `POST /api/pipelines/${id}/cancel failed (${res.status}): ${body.slice(0, 200) || res.statusText}`,
    );
  }
  return readJson<{ pipeline: Pipeline }>(res);
}

/** Body shape for `POST /api/pipelines/:id/review/decision`. */
export type ReviewDecisionInput = {
  decision: "approved" | "approved_with_changes" | "rejected";
  notes?: string;
};

/**
 * Submit the operator's review-stage decision. On `approved` /
 * `approved_with_changes` the server snapshots `cost_estimate`, transitions
 * the pipeline to `generation`, and fires off the worker; on `rejected` the
 * pipeline moves to `cancelled`. Returns the updated pipeline row so callers
 * can optimistically reconcile UI state without a follow-up GET.
 */
export async function submitReviewDecision(
  id: string,
  decision: ReviewDecisionInput,
): Promise<{ pipeline: Pipeline }> {
  const res = await fetch(
    `${resolveBaseUrl()}/api/pipelines/${encodeURIComponent(id)}/review/decision`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(decision),
      cache: "no-store",
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `POST /api/pipelines/${id}/review/decision failed (${res.status}): ${
        body.slice(0, 200) || res.statusText
      }`,
    );
  }
  return readJson<{ pipeline: Pipeline }>(res);
}
