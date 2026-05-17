import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MiddlewareModule = typeof import("./middleware");

function makeReq(opts: {
  ip?: string | null;
  realIp?: string | null;
  path?: string;
}): import("next/server").NextRequest {
  const headers = new Headers();
  if (opts.ip !== undefined && opts.ip !== null) headers.set("x-forwarded-for", opts.ip);
  if (opts.realIp !== undefined && opts.realIp !== null) headers.set("x-real-ip", opts.realIp);
  return {
    headers,
    nextUrl: { pathname: opts.path ?? "/" },
  } as unknown as import("next/server").NextRequest;
}

async function loadMiddleware(env: Record<string, string | undefined>): Promise<MiddlewareModule> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.unstubAllEnvs();
    else vi.stubEnv(k, v);
  }
  vi.resetModules();
  return await import("./middleware");
}

describe("middleware (Tailscale gate)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("disabled mode (TAILSCALE_ONLY unset)", () => {
    it("passes every request through without inspecting IP", async () => {
      const mod = await loadMiddleware({ TAILSCALE_ONLY: "" });
      const res = mod.middleware(makeReq({ ip: "203.0.113.5" }));
      // NextResponse.next() resolves to a 200-ish response with no body.
      expect(res).toBeDefined();
      expect(res.status).toBeLessThan(400);
    });
  });

  describe("log mode (TAILSCALE_ONLY=1)", () => {
    it("allows tailnet IPv4 without logging", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mod = await loadMiddleware({ TAILSCALE_ONLY: "1" });
      const res = mod.middleware(makeReq({ ip: "100.96.0.5" }));
      expect(res.status).toBeLessThan(400);
      expect(warn).not.toHaveBeenCalled();
    });

    it("logs off-tailnet IPv4 but lets it through", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mod = await loadMiddleware({ TAILSCALE_ONLY: "1" });
      const res = mod.middleware(makeReq({ ip: "203.0.113.5", path: "/dashboard" }));
      expect(res.status).toBeLessThan(400);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("non-tailnet request ip=203.0.113.5 path=/dashboard"),
      );
    });

    it("warns when no IP header is present and passes through", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mod = await loadMiddleware({ TAILSCALE_ONLY: "1" });
      const res = mod.middleware(makeReq({}));
      expect(res.status).toBeLessThan(400);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no client IP header"));
    });

    it("reads x-real-ip when x-forwarded-for is absent", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mod = await loadMiddleware({ TAILSCALE_ONLY: "1" });
      const res = mod.middleware(makeReq({ realIp: "100.96.0.7" }));
      expect(res.status).toBeLessThan(400);
      expect(warn).not.toHaveBeenCalled();
    });

    it("uses only the first IP from a comma-separated x-forwarded-for chain", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mod = await loadMiddleware({ TAILSCALE_ONLY: "1" });
      // First hop is tailnet → allowed; downstream non-tailnet IPs in the chain don't matter.
      const res = mod.middleware(makeReq({ ip: "100.96.0.5, 10.0.0.1, 203.0.113.5" }));
      expect(res.status).toBeLessThan(400);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("strict mode (TAILSCALE_ONLY=strict)", () => {
    it("403s off-tailnet IPv4 requests", async () => {
      const mod = await loadMiddleware({ TAILSCALE_ONLY: "strict" });
      const res = mod.middleware(makeReq({ ip: "203.0.113.5" }));
      expect(res.status).toBe(403);
    });

    it("403s requests with no client IP header", async () => {
      const mod = await loadMiddleware({ TAILSCALE_ONLY: "strict" });
      const res = mod.middleware(makeReq({}));
      expect(res.status).toBe(403);
    });

    it("permits in-range tailnet IPv4 traffic", async () => {
      const mod = await loadMiddleware({ TAILSCALE_ONLY: "strict" });
      const res = mod.middleware(makeReq({ ip: "100.64.0.1" }));
      expect(res.status).toBeLessThan(400);
    });
  });

  describe("custom TAILSCALE_CIDRS", () => {
    it("respects an additional IPv4 CIDR override", async () => {
      const mod = await loadMiddleware({
        TAILSCALE_ONLY: "strict",
        TAILSCALE_CIDRS: "10.0.0.0/8",
      });
      // 10.x is allowed by the override; default 100.64/10 is replaced not added.
      expect(mod.middleware(makeReq({ ip: "10.5.5.5" })).status).toBeLessThan(400);
      expect(mod.middleware(makeReq({ ip: "100.64.0.1" })).status).toBe(403);
    });

    it("filters out malformed CIDR entries silently", async () => {
      const mod = await loadMiddleware({
        TAILSCALE_ONLY: "strict",
        TAILSCALE_CIDRS: "not-a-cidr,10.0.0.0/8,bogus/99",
      });
      // The one valid CIDR still works.
      expect(mod.middleware(makeReq({ ip: "10.0.0.1" })).status).toBeLessThan(400);
    });

    it("matches IPv6 CIDRs", async () => {
      const mod = await loadMiddleware({
        TAILSCALE_ONLY: "strict",
        TAILSCALE_CIDRS: "fd7a:115c:a1e0::/48",
      });
      expect(mod.middleware(makeReq({ ip: "fd7a:115c:a1e0::1" })).status).toBeLessThan(400);
      expect(mod.middleware(makeReq({ ip: "fe80::1" })).status).toBe(403);
    });

    it("treats /0 as match-all", async () => {
      const mod = await loadMiddleware({
        TAILSCALE_ONLY: "strict",
        TAILSCALE_CIDRS: "0.0.0.0/0",
      });
      expect(mod.middleware(makeReq({ ip: "203.0.113.5" })).status).toBeLessThan(400);
    });
  });

  describe("CIDR / IP parsing edge cases", () => {
    it("rejects malformed IPv4 octets without crashing", async () => {
      const mod = await loadMiddleware({ TAILSCALE_ONLY: "strict" });
      // Out-of-range octet → unparseable → no match → 403 in strict mode.
      expect(mod.middleware(makeReq({ ip: "999.0.0.1" })).status).toBe(403);
      expect(mod.middleware(makeReq({ ip: "1.2.3" })).status).toBe(403);
      // Non-numeric octet (the parser also guards against e.g. "1.2.3.04").
      expect(mod.middleware(makeReq({ ip: "1.2.3.04" })).status).toBe(403);
    });

    it("rejects malformed IPv6 addresses", async () => {
      const mod = await loadMiddleware({
        TAILSCALE_ONLY: "strict",
        TAILSCALE_CIDRS: "fd00::/8",
      });
      expect(mod.middleware(makeReq({ ip: "::xyzz" })).status).toBe(403);
      expect(mod.middleware(makeReq({ ip: "1::2::3" })).status).toBe(403);
    });
  });

  describe("config", () => {
    it("excludes Next internals and api/health from the matcher", async () => {
      const mod = await loadMiddleware({ TAILSCALE_ONLY: "strict" });
      expect(mod.config.matcher).toEqual([
        "/((?!_next/static|_next/image|favicon.ico|api/health).*)",
      ]);
    });
  });
});
