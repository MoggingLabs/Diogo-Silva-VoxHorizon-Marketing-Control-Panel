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
