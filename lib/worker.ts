import "server-only";

import { cleanEnv } from "@/lib/env";

export type WorkerHealth = {
  ok: boolean;
  service?: string;
  version?: string;
  uptime_seconds?: number;
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
export async function callWorker<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
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
  throw new WorkerError(
    `Worker request to ${path} failed after retry`,
    undefined,
    lastError,
  );
}

/**
 * Typed worker RPC surface. Add new endpoints here as later milestones land.
 */
export const worker = {
  health: () => callWorker<WorkerHealth>("/work/health"),
};
