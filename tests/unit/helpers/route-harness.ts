/**
 * Next.js App-Router API-route test harness (T.3 / #316).
 *
 * The rebuild adds a stack of `app/api/.../route.ts` handlers that proxy to
 * the FastAPI worker and/or read Supabase. This harness lets a test invoke a
 * route handler directly with a `Request` and mock its *outbound* HTTP at the
 * network boundary with `msw` (already a workspace dep) — no module mocking,
 * no real worker, no real Supabase.
 *
 * Why MSW (vs. the `fetch`-spy helpers in `worker-mock.ts`)? Route handlers
 * reach the outside world two ways, and both are plain HTTP:
 *
 *   - the worker pass-throughs `fetch(`${WORKER_URL}/work/...`)` (see
 *     `app/api/approval-mode/route.ts`, `lib/worker.ts`);
 *   - the service-role Supabase client, which is just a PostgREST HTTP client
 *     against `${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/...` (see
 *     `lib/supabase/admin.ts`).
 *
 * Intercepting at the HTTP layer exercises the real request the route builds
 * (URL, method, Authorization header, JSON body) instead of asserting against
 * a hand-rolled chain mock, so a contract drift in the route shows up as a
 * failing handler — not a silently-passing stub. The `fetch`-spy helpers stay
 * the right tool for fine-grained "what exact args did we send" assertions;
 * this harness is the right tool for happy/401/422 contract tests.
 *
 * Usage:
 *
 *   import { setupRouteHarness, workerJson, callRoute } from "./route-harness";
 *
 *   const harness = setupRouteHarness();  // registers MSW lifecycle hooks
 *
 *   it("proxies the worker happy path", async () => {
 *     harness.worker.get("/work/hermes/approval-mode", workerJson({ mode: "ASK" }));
 *     const res = await callRoute(GET);
 *     expect(res.status).toBe(200);
 *   });
 */
import { http, HttpResponse, type HttpHandler, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

/** The concrete server type `setupServer()` returns (avoids `SetupServerApi`). */
type MswServer = ReturnType<typeof setupServer>;

/** Default origins the harness binds env + handlers to. */
export const WORKER_BASE = "http://worker.test";
export const SUPABASE_BASE = "http://supabase.test";

/** A `Response` (or its async producer) MSW returns for a stubbed call. */
type Responder = Response | ((info: { request: Request }) => Response | Promise<Response>);

/** JSON `Response` builder mirroring the route handlers' own JSON shape. */
export function workerJson(body: JsonBodyType, init: ResponseInit = {}): Response {
  return HttpResponse.json(body, init) as unknown as Response;
}

/** Plain-text `Response` builder (for non-JSON worker error bodies). */
export function workerText(body: string, init: ResponseInit = {}): Response {
  return HttpResponse.text(body, init) as unknown as Response;
}

function toResolver(responder: Responder) {
  return responder instanceof Response
    ? () => responder.clone()
    : ({ request }: { request: Request }) => responder({ request });
}

/**
 * Thin per-origin handler registrar. `get`/`post`/`put`/`patch`/`delete`
 * append a one-off MSW handler scoped to the given base URL; the path is
 * joined to the base so callers pass worker/Supabase-relative paths.
 */
function makeOrigin(server: MswServer, base: string) {
  const url = (path: string) => `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const register = (
    method: (path: string, resolver: ReturnType<typeof toResolver>) => HttpHandler,
    path: string,
    responder: Responder,
  ) => {
    server.use(method(url(path), toResolver(responder) as never));
  };
  return {
    base,
    get: (path: string, responder: Responder) => register(http.get, path, responder),
    post: (path: string, responder: Responder) => register(http.post, path, responder),
    put: (path: string, responder: Responder) => register(http.put, path, responder),
    patch: (path: string, responder: Responder) => register(http.patch, path, responder),
    delete: (path: string, responder: Responder) => register(http.delete, path, responder),
  };
}

export type RouteHarness = {
  /** The underlying MSW server, for advanced one-off `.use(...)` registration. */
  server: MswServer;
  /** Register handlers against the worker origin (`WORKER_URL`). */
  worker: ReturnType<typeof makeOrigin>;
  /** Register handlers against the Supabase PostgREST origin. */
  supabase: ReturnType<typeof makeOrigin>;
};

export type RouteHarnessOptions = {
  /** Env vars the routes read. Sensible defaults wire worker + Supabase. */
  env?: Record<string, string>;
};

/**
 * Stand up an MSW server with Vitest lifecycle hooks and the env every
 * worker/Supabase-backed route reads. Returns origin registrars.
 *
 * - `beforeAll`  — start MSW; unhandled requests *error* so a route hitting an
 *                  un-stubbed URL fails loudly instead of escaping to the net.
 * - `afterEach`  — reset handlers + restore stubbed env between tests.
 * - `afterAll`   — close MSW.
 *
 * Call once at the top of a describe block.
 */
export function setupRouteHarness(options: RouteHarnessOptions = {}): RouteHarness {
  const server = setupServer();

  const env: Record<string, string> = {
    WORKER_URL: WORKER_BASE,
    WORKER_SHARED_SECRET: "test-worker-secret",
    VOXHORIZON_APPROVAL_TOKEN: "test-approval-token",
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_BASE,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_SECRET_KEY: "test-service-key",
    ...options.env,
  };

  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
  });

  // Apply the route env before every test (and restore after) so each test
  // starts from the same wired worker + Supabase config. A test can override
  // a single var with `vi.stubEnv(...)` inside its own body — that override
  // wins until the next `afterEach` restores the baseline.
  beforeEach(() => {
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
  });

  afterEach(() => {
    server.resetHandlers();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    server.close();
  });

  return {
    server,
    worker: makeOrigin(server, WORKER_BASE),
    supabase: makeOrigin(server, SUPABASE_BASE),
  };
}

/**
 * Build a `Request` for a route handler. Object bodies are JSON-encoded with
 * the matching `Content-Type`; string/undefined bodies pass through. The URL
 * defaults to a harmless localhost origin since most handlers only read the
 * body + method, not the URL.
 */
export function makeRouteRequest(
  init: {
    method?: string;
    url?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Request {
  const { method = "GET", url = "http://localhost/api/test", body, headers = {} } = init;
  const finalHeaders = new Headers(headers);
  let encodedBody: BodyInit | undefined;
  if (body !== undefined) {
    if (typeof body === "string") {
      encodedBody = body;
    } else {
      encodedBody = JSON.stringify(body);
      if (!finalHeaders.has("content-type")) {
        finalHeaders.set("content-type", "application/json");
      }
    }
  }
  return new Request(url, { method, headers: finalHeaders, body: encodedBody });
}

/**
 * Invoke a route handler and return its `Response`. Accepts the optional
 * handler args App-Router passes (a `Request`/`NextRequest` and a
 * `{ params }` context). Handlers that take no args (e.g. a bare `GET()`)
 * ignore them.
 */
export async function callRoute<A extends unknown[]>(
  handler: (...args: A) => Promise<Response> | Response,
  ...args: A
): Promise<Response> {
  return handler(...args);
}

/**
 * Convenience: build a route-context object whose `params` resolves to the
 * given record. App-Router awaits `ctx.params`, so it must be a promise.
 */
export function routeContext<P extends Record<string, string>>(params: P): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}
