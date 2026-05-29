import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { issueSessionToken, SESSION_COOKIE } from "./lib/auth/session";

const SECRET = "test-session-secret-0123456789";

type MiddlewareModule = typeof import("./middleware");

/**
 * Build a `NextRequest`-shaped object the middleware can read. The middleware
 * only touches `req.nextUrl.{pathname,search,clone}` and
 * `req.headers.get("cookie")`, so we stub exactly that surface. `clone()`
 * returns a mutable URL the redirect path mutates.
 */
function makeReq(opts: {
  path?: string;
  search?: string;
  cookie?: string | null;
  headers?: Record<string, string>;
}): import("next/server").NextRequest {
  const pathname = opts.path ?? "/";
  const search = opts.search ?? "";
  const headers = new Headers(opts.headers);
  if (opts.cookie) headers.set("cookie", opts.cookie);

  const nextUrl = {
    pathname,
    search,
    clone() {
      // A real URL so `.searchParams.set` + `.pathname=` behave like Next's.
      return new URL(`http://localhost${pathname}${search}`);
    },
  };

  return {
    headers,
    nextUrl,
  } as unknown as import("next/server").NextRequest;
}

async function loadMiddleware(): Promise<MiddlewareModule> {
  vi.resetModules();
  return await import("./middleware");
}

async function validCookie(email = "operator@example.com"): Promise<string> {
  vi.stubEnv("SESSION_SECRET", SECRET);
  const token = await issueSessionToken(email);
  return `${SESSION_COOKIE}=${token}`;
}

describe("middleware (single-operator session gate)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("public paths (no session required)", () => {
    it.each(["/login", "/api/auth/login", "/api/auth/logout", "/api/health"])(
      "allows %s without a session cookie",
      async (path) => {
        const mod = await loadMiddleware();
        const res = await mod.middleware(makeReq({ path }));
        expect(res.status).toBeLessThan(400);
        // No redirect Location header for a public route.
        expect(res.headers.get("location")).toBeNull();
      },
    );
  });

  describe("m2m exemption (worker -> Next bearer routes)", () => {
    it("lets /api/internal/approval-email through WITHOUT a session cookie", async () => {
      const mod = await loadMiddleware();
      // No cookie at all — proves the worker callback is not blocked by the gate.
      const res = await mod.middleware(makeReq({ path: "/api/internal/approval-email" }));
      expect(res.status).toBeLessThan(400);
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("page requests without a valid session", () => {
    it("redirects an unauthenticated page request to /login with ?next", async () => {
      const mod = await loadMiddleware();
      const res = await mod.middleware(makeReq({ path: "/pipeline", search: "?a=1" }));
      expect(res.status).toBe(307);
      const loc = res.headers.get("location");
      expect(loc).toBeTruthy();
      const url = new URL(loc!);
      expect(url.pathname).toBe("/login");
      expect(url.searchParams.get("next")).toBe("/pipeline?a=1");
    });

    it("does not set ?next when the destination is already /login", async () => {
      const mod = await loadMiddleware();
      // A bare "/" page request: next would be "/" which is fine to round-trip.
      const res = await mod.middleware(makeReq({ path: "/" }));
      expect(res.status).toBe(307);
      const url = new URL(res.headers.get("location")!);
      expect(url.pathname).toBe("/login");
      expect(url.searchParams.get("next")).toBe("/");
    });
  });

  describe("api requests without a valid session", () => {
    it("returns 401 JSON (no redirect) for a gated /api/* route", async () => {
      const mod = await loadMiddleware();
      const res = await mod.middleware(makeReq({ path: "/api/pipelines" }));
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      const body = await res.json();
      expect(body.error).toBe("unauthenticated");
    });
  });

  describe("RSC-class page requests without a valid session", () => {
    it("returns 401 JSON (not a 307) for an RSC soft-navigation", async () => {
      const mod = await loadMiddleware();
      const res = await mod.middleware(makeReq({ path: "/pipeline", headers: { RSC: "1" } }));
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      const body = await res.json();
      expect(body.error).toBe("unauthenticated");
    });

    it("returns 401 JSON for a router prefetch", async () => {
      const mod = await loadMiddleware();
      const res = await mod.middleware(
        makeReq({ path: "/pipeline", headers: { "Next-Router-Prefetch": "1" } }),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
    });

    it("returns 401 JSON for a Server Action POST", async () => {
      const mod = await loadMiddleware();
      const res = await mod.middleware(
        makeReq({ path: "/pipeline", headers: { "Next-Action": "abc123" } }),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
    });

    it("still 307-redirects a normal document page request (no RSC headers)", async () => {
      const mod = await loadMiddleware();
      const res = await mod.middleware(makeReq({ path: "/pipeline" }));
      expect(res.status).toBe(307);
      const url = new URL(res.headers.get("location")!);
      expect(url.pathname).toBe("/login");
      expect(url.searchParams.get("next")).toBe("/pipeline");
    });

    it("allows an authenticated RSC navigation through", async () => {
      const cookie = await validCookie();
      const mod = await loadMiddleware();
      const res = await mod.middleware(
        makeReq({ path: "/pipeline", cookie, headers: { RSC: "1" } }),
      );
      expect(res.status).toBeLessThan(400);
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("authenticated requests", () => {
    it("allows a gated page request with a valid session cookie", async () => {
      const cookie = await validCookie();
      const mod = await loadMiddleware();
      const res = await mod.middleware(makeReq({ path: "/pipeline", cookie }));
      expect(res.status).toBeLessThan(400);
      expect(res.headers.get("location")).toBeNull();
    });

    it("allows a gated /api/* request with a valid session cookie", async () => {
      const cookie = await validCookie();
      const mod = await loadMiddleware();
      const res = await mod.middleware(makeReq({ path: "/api/pipelines", cookie }));
      expect(res.status).toBeLessThan(400);
    });

    it("rejects a tampered cookie (treated as no session)", async () => {
      const cookie = await validCookie();
      const tampered = `${cookie}TAMPER`;
      const mod = await loadMiddleware();
      const res = await mod.middleware(makeReq({ path: "/api/pipelines", cookie: tampered }));
      expect(res.status).toBe(401);
    });
  });

  describe("config", () => {
    it("excludes Next internals and api/health from the matcher", async () => {
      const mod = await loadMiddleware();
      expect(mod.config.matcher).toEqual([
        "/((?!_next/static|_next/image|favicon.ico|api/health).*)",
      ]);
    });
  });
});
