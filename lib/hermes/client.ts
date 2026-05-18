import "server-only";

import { cleanEnv } from "@/lib/env";

/**
 * Typed client for the worker's `/work/hermes/*` bridge endpoints.
 *
 * The bridge (introduced in Wave 18) replaces the legacy
 * `/work/chat/creative`, `/work/pipeline/*`, etc. routes. It exposes:
 *
 *   - `POST /work/hermes/chat` — SSE stream from a `hermes chat -q "..."`
 *     exec inside the sibling `hermes-agent-ekko` container.
 *   - `POST /work/hermes/chat/abort` — SIGTERM the live exec for a session.
 *   - `POST /work/hermes/kanban` — create a task assigned to `ekko` (or
 *     another agent) with an optional parent.
 *   - `GET  /work/hermes/kanban/{task_id}` — read a task's state.
 *   - `POST /work/hermes/kanban/{task_id}/cancel` — block (operator cancel).
 *   - `POST /work/hermes/kanban/{task_id}/retry` — reclaim + unblock.
 *   - `GET  /work/hermes/kanban/{task_id}/events` — SSE event tail.
 *
 * This module mirrors the shape of `lib/worker.ts`: a generic
 * `callHermes` helper does the bearer auth + retry + timeout dance,
 * and named entry points compose typed call sites. The two SSE
 * endpoints (`chat` and `kanban-events`) skip `callHermes` and use raw
 * fetch so callers can stream the body straight through to the
 * browser.
 */

// ---------------------------------------------------------------------------
// Types — mirror the worker's pydantic schemas.
// ---------------------------------------------------------------------------

/** One chat message — role + content. */
export type HermesChatMessage = {
  role: string;
  content: string;
};

/** Body for `POST /work/hermes/chat`. */
export type HermesChatRequest = {
  messages: HermesChatMessage[];
  session_id?: string | null;
  system_prompt?: string | null;
};

/** Body for `POST /work/hermes/chat/abort`. */
export type HermesChatAbortRequest = {
  session_id: string;
};

/** Response from `POST /work/hermes/chat/abort`. */
export type HermesChatAbortResponse = {
  aborted: boolean;
};

/** Body for `POST /work/hermes/kanban`. */
export type HermesKanbanCreateRequest = {
  title: string;
  /** Defaults to "ekko" on the worker; callers can override per board. */
  assignee?: string;
  /** Free-form context bag the agent will see — `{kind, pipeline_id, ...}`. */
  context?: Record<string, unknown>;
  parent_id?: string | null;
  board?: string | null;
};

/** Response from `POST /work/hermes/kanban`. */
export type HermesKanbanCreateResponse = {
  task_id: string;
  assignee: string;
  board: string;
};

/** Response from `POST /work/hermes/kanban/{id}/{cancel|retry}`. */
export type HermesKanbanActionResponse = {
  task_id: string;
  action: string;
  ok: boolean;
};

/** Shape of a kanban task as returned by `GET /work/hermes/kanban/{id}`. */
export type HermesKanbanTask = {
  id: string;
  status: string;
  assignee: string;
  title: string;
  board: string;
  context: Record<string, unknown>;
  result: Record<string, unknown> | null;
  comments: unknown[];
  events: unknown[];
  parent_id: string | null;
};

export class HermesError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HermesError";
  }
}

// ---------------------------------------------------------------------------
// Internals — shared fetch w/ retry mirroring `lib/worker.ts`.
// ---------------------------------------------------------------------------

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

function workerUrl(path: string): { url: string; secret: string } {
  const base = cleanEnv("WORKER_URL").replace(/\/$/, "");
  const secret = cleanEnv("WORKER_SHARED_SECRET");
  return {
    url: `${base}${path.startsWith("/") ? path : `/${path}`}`,
    secret,
  };
}

/**
 * Bearer-authed JSON call to the hermes bridge with one retry on
 * transient failures. Mirrors `lib/worker.ts:callWorker` so error shapes
 * stay consistent across the two surfaces.
 */
async function callHermes<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, secret } = workerUrl(path);

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
        throw new HermesError(
          `Hermes responded ${res.status} for ${path}${text ? `: ${text.slice(0, 200)}` : ""}`,
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
      if (err instanceof HermesError && !isTransient(err.status)) throw err;
      if (attempt === 0) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
    }
  }

  if (lastError instanceof HermesError) throw lastError;
  throw new HermesError(`Hermes request to ${path} failed after retry`, undefined, lastError);
}

// ---------------------------------------------------------------------------
// Streaming endpoints — caller owns the response body.
// ---------------------------------------------------------------------------

/**
 * Open the SSE stream for `POST /work/hermes/chat`. Returns the raw
 * `Response` so the Next.js route can pipe `response.body` straight
 * back to the browser without buffering. The `signal` parameter wires
 * the browser's `fetch` abort signal into the upstream so a Cancel
 * click also tears down the worker connection.
 *
 * The caller is responsible for handling non-2xx — the bridge route
 * itself only returns 200 (errors arrive as `{"type":"error", ...}`
 * SSE frames mid-stream), but a network blip can still surface here as
 * a 5xx and the proxy route already normalises that to a 502 JSON
 * envelope. We don't pre-read the body so the SSE stream stays live.
 */
export async function chatStream(body: HermesChatRequest, signal?: AbortSignal): Promise<Response> {
  const { url, secret } = workerUrl("/work/hermes/chat");
  return await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal,
  });
}

/**
 * Open the SSE stream for `GET /work/hermes/kanban/{task_id}/events`.
 * Same lifecycle as `chatStream` — caller pipes the body through.
 *
 * Not currently used by the API routes we're rewriting (the dashboard
 * subscribes to Supabase realtime for task updates), but exposed for
 * symmetry with the worker surface.
 */
export async function kanbanEvents(taskId: string, signal?: AbortSignal): Promise<Response> {
  const { url, secret } = workerUrl(`/work/hermes/kanban/${encodeURIComponent(taskId)}/events`);
  return await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${secret}`,
      Accept: "text/event-stream",
    },
    cache: "no-store",
    signal,
  });
}

// ---------------------------------------------------------------------------
// JSON RPC entry points
// ---------------------------------------------------------------------------

/** POST /work/hermes/chat/abort — flip the SIGTERM for an in-flight exec. */
export async function chatAbort(body: HermesChatAbortRequest): Promise<HermesChatAbortResponse> {
  return await callHermes<HermesChatAbortResponse>("/work/hermes/chat/abort", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** POST /work/hermes/kanban — create a task. */
export async function kanbanCreate(
  body: HermesKanbanCreateRequest,
): Promise<HermesKanbanCreateResponse> {
  return await callHermes<HermesKanbanCreateResponse>("/work/hermes/kanban", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** GET /work/hermes/kanban/{task_id} — read full task state. */
export async function kanbanGet(taskId: string): Promise<HermesKanbanTask> {
  return await callHermes<HermesKanbanTask>(`/work/hermes/kanban/${encodeURIComponent(taskId)}`);
}

/** POST /work/hermes/kanban/{task_id}/cancel — block (operator cancel). */
export async function kanbanCancel(taskId: string): Promise<HermesKanbanActionResponse> {
  return await callHermes<HermesKanbanActionResponse>(
    `/work/hermes/kanban/${encodeURIComponent(taskId)}/cancel`,
    { method: "POST" },
  );
}

/** POST /work/hermes/kanban/{task_id}/retry — reclaim + unblock. */
export async function kanbanRetry(taskId: string): Promise<HermesKanbanActionResponse> {
  return await callHermes<HermesKanbanActionResponse>(
    `/work/hermes/kanban/${encodeURIComponent(taskId)}/retry`,
    { method: "POST" },
  );
}

/**
 * Typed grouping that mirrors `lib/worker.ts`'s `worker` namespace.
 * Routes typically import the named functions directly; this lives
 * here so the call surface is greppable as a unit.
 */
export const hermes = {
  chatStream,
  chatAbort,
  kanbanCreate,
  kanbanGet,
  kanbanCancel,
  kanbanRetry,
  kanbanEvents,
};
