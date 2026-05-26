import "server-only";

import { cleanEnv } from "@/lib/env";

export type WorkerHealth = {
  ok: boolean;
  service?: string;
  version?: string;
  uptime_seconds?: number;
  [key: string]: unknown;
};

/**
 * One creative to (re-)QA. Mirrors the worker's `QAItem` (qa_compliance.py):
 * the operator supplies the `creative_id` + the surface; the worker fetches the
 * bytes / probes the MP4 itself and computes the verdict (the operator never
 * asserts a pass). `image_b64`/`overlay_region` are optional fast-paths.
 */
export type WorkerQAItem = {
  creative_id: string;
  surface?: "image" | "video";
  vertical?: string | null;
  ratio?: string;
};

/** Body for `POST /work/pipeline/tools/qa_run`. */
export type WorkerQARunInput = {
  pipeline_id: string;
  items: WorkerQAItem[];
};

/** Per-creative result row in the qa_run response. */
export type WorkerQAResult = {
  creative_id: string;
  surface: "image" | "video";
  verdict: string;
  status: string;
  attempt: number;
  rerender_recommended: boolean;
  defect_count: number;
};

/** Response from `POST /work/pipeline/tools/qa_run`. */
export type WorkerQARunResponse = {
  ok: boolean;
  pipeline_id: string;
  stage: "creative_qa";
  rollup: string;
  results: WorkerQAResult[];
  errors: Array<{ creative_id: string; error: string }>;
};

/** One per-placement spec result. Mirrors the worker's `SpecResult`. */
export type WorkerSpecResult = {
  creative_id: string;
  platform?: "meta" | "google" | "tiktok";
  placement: string;
  ratio?: string | null;
  status: "pending" | "pass" | "warn" | "fail" | "exception";
  checks?: Record<string, unknown>;
  derived_path_supabase?: string | null;
  derived_path_drive?: string | null;
};

/** Body for `POST /work/pipeline/tools/spec_result`. */
export type WorkerSpecInput = {
  pipeline_id: string;
  results: WorkerSpecResult[];
};

/** Response from `POST /work/pipeline/tools/spec_result`. */
export type WorkerSpecResponse = {
  ok?: boolean;
  pipeline_id?: string;
  stage?: string;
  [key: string]: unknown;
};

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorkerError";
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_BACKOFF_MS = 250;

function isTransient(status?: number): boolean {
  if (status === undefined) return true; // network error, abort, etc.
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status < 600;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call the worker service. Adds Bearer auth from `WORKER_SHARED_SECRET`,
 * enforces a 5s timeout, and retries once on transient failures.
 *
 * Throws `WorkerError` on non-2xx responses or network/abort errors after
 * the retry.
 */
export async function callWorker<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const base = cleanEnv("WORKER_URL").replace(/\/$/, "");
  const secret = cleanEnv("WORKER_SHARED_SECRET");
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${secret}`);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(
        url,
        { ...init, headers, cache: "no-store" },
        DEFAULT_TIMEOUT_MS,
      );

      if (!res.ok) {
        if (isTransient(res.status) && attempt === 0) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        const text = await res.text().catch(() => "");
        throw new WorkerError(
          `Worker responded ${res.status} for ${path}${text ? `: ${text.slice(0, 200)}` : ""}`,
          res.status,
        );
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        return (await res.text()) as unknown as T;
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (err instanceof WorkerError && !isTransient(err.status)) throw err;
      if (attempt === 0) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
    }
  }

  if (lastError instanceof WorkerError) throw lastError;
  throw new WorkerError(`Worker request to ${path} failed after retry`, undefined, lastError);
}

/**
 * Re-run creative QA for a batch via `POST /work/pipeline/tools/qa_run`.
 *
 * APPEND-ONLY guardrail: the worker INSERTs a NEW `qa_result` attempt
 * (`unique(creative_id, attempt)`) and rolls the verdict onto
 * `creative_stage_state(creative_qa)`; it never edits a prior attempt. The
 * dashboard's "re-run QA" action is this call — corrective evidence is a new
 * row, the immutable audit history stays intact (migration 0041).
 */
export async function qaRun(body: WorkerQARunInput): Promise<WorkerQARunResponse> {
  return await callWorker<WorkerQARunResponse>("/work/pipeline/tools/qa_run", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * (Re-)submit per-placement spec results via `POST /work/pipeline/tools/spec_result`.
 *
 * OVERRIDE-ROUTE guardrail: `spec_check` is worker-upserted (idempotent on
 * `(creative_id, platform, placement)`) and the gate rolls onto
 * `creative_stage_state(spec_validation)`. A manager spec override is a
 * corrected result submitted through this route + the DB rollup, never a raw
 * UPDATE of the source row from the browser.
 */
export async function specRun(body: WorkerSpecInput): Promise<WorkerSpecResponse> {
  return await callWorker<WorkerSpecResponse>("/work/pipeline/tools/spec_result", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Typed worker RPC surface. Add new endpoints here as later milestones land.
 */
export const worker = {
  health: () => callWorker<WorkerHealth>("/work/health"),
  qaRun,
  specRun,
};
