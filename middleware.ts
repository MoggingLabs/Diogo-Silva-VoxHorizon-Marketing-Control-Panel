import { NextResponse, type NextRequest } from "next/server";

import { readSessionFromRequest } from "@/lib/auth/session";

/**
 * Single-operator session gate (app-layer auth, defense-in-depth).
 *
 * REPLACES the previous default-disabled Tailscale IP gate. The dashboard
 * still sits behind Caddy HTTP Basic Auth at the edge (the OUTER layer, kept),
 * but this middleware adds a REAL app-layer boundary that no longer relies
 * solely on the edge: every non-public request must carry a valid signed
 * session cookie (issued by `POST /api/auth/login`, verified here via
 * `lib/auth/session`). The cookie is HttpOnly + SameSite=Lax (CSRF defense).
 *
 * Posture: single-operator. This is NOT per-user / multi-tenant auth and does
 * NOT touch RLS — server reads stay on the service-role client. The gate is
 * identity + access control at the app boundary only.
 *
 * Request handling:
 *   - PUBLIC paths (always allowed, no session needed):
 *       /login                  the login screen itself
 *       /api/auth/*             login + logout endpoints
 *       /api/health             public liveness probe (also excluded in matcher)
 *     plus Next.js internals + static assets (excluded in the matcher below).
 *
 *   - M2M EXEMPTION (machine callers that authenticate with a bearer, NOT a
 *     browser session): see {@link M2M_EXEMPT_PATHS}. These routes do their OWN
 *     bearer auth; the session gate must not 401 them or it would break the
 *     worker -> Next callback in prod.
 *
 *   - Everything else: validate the session cookie.
 *       missing/expired/tampered + page request  -> 307 redirect to
 *         /login?next=<original path> (so the operator lands back where they were)
 *       missing/expired/tampered + /api/* request -> 401 JSON (no redirect: an
 *         XHR/fetch wants a status code, not an HTML login page)
 */

/**
 * Worker -> Next machine-to-machine routes that authenticate with their OWN
 * bearer secret, NOT a browser session cookie. The session gate exempts these
 * so the worker callback keeps working in prod.
 *
 * EVIDENCE (audited from app/api/**; the only INCOMING bearer-authenticated
 * route in the tree):
 *   - /api/internal/approval-email
 *       app/api/internal/approval-email/route.ts verifies
 *       `Authorization: Bearer <INTERNAL_API_TOKEN>` via a constant-time
 *       `timingSafeEqual` (route.ts:167-182) and fails closed when the env
 *       token is unset. The Python worker is the caller
 *       (worker/src/services/approval_notifications.py). It presents a bearer,
 *       never a session cookie, so the session gate must let it through to the
 *       route's own auth.
 *
 * Routes that LOOK m2m but are NOT (kept GATED, audited):
 *   - /api/worker/health, /api/operator/daemon-health, /api/realtime,
 *     /api/pipelines/**, /api/approval-mode/** etc. — these are called by the
 *     BROWSER dashboard. The `Authorization: Bearer` strings in those files are
 *     OUTGOING (Next -> worker), set on `fetch(...)` to the worker; nothing in
 *     them reads an incoming bearer. They must stay behind the session gate.
 *   - The operator daemon talks to the WORKER's `/work/queue/*` (port 8000),
 *     not to Next (operator-daemon/voxhorizon_daemon/queue_client.py), so it
 *     needs no Next-side exemption.
 */
const M2M_EXEMPT_PATHS = ["/api/internal/"];

/** Public paths that never require a session. */
const PUBLIC_PATHS = ["/login", "/api/auth/", "/api/health"];

function isPrefixed(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p));
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // Public + m2m-exempt routes skip the session check entirely.
  if (isPrefixed(pathname, PUBLIC_PATHS) || isPrefixed(pathname, M2M_EXEMPT_PATHS)) {
    return NextResponse.next();
  }

  // Validate the signed session cookie. `readSessionFromRequest` returns null
  // for a missing, malformed, tampered, or expired token (and also when
  // SESSION_SECRET is unset — it fails closed rather than throwing here).
  const session = await readSessionFromRequest(req);
  if (session) {
    return NextResponse.next();
  }

  // No valid session. API callers get a machine-readable 401; page requests
  // get bounced to the login screen carrying the original path so the operator
  // returns where they started after signing in.
  //
  // RSC-class requests (a soft client-side navigation / prefetch / Server
  // Action) also want a status code, NOT an HTML login page: returning a 307 to
  // /login for those would hand the router a redirect to an HTML document it
  // can't fold into the flight stream, and the navigation stalls. A clean 401
  // makes the client fall back to a hard reload, which then hits the page-
  // redirect branch below and lands on /login as a real document.
  const isRscLike =
    req.headers.get("RSC") === "1" ||
    req.headers.has("Next-Router-Prefetch") ||
    req.headers.has("Next-Action");
  if (pathname.startsWith("/api/") || isRscLike) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  const nextTarget = pathname + req.nextUrl.search;
  // Only round-trip a real in-app destination (avoid `?next=/login`).
  if (nextTarget && nextTarget !== "/login") {
    loginUrl.searchParams.set("next", nextTarget);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Run on everything except Next.js internals, public assets, and the
    // public health probe used by uptime monitors. The session gate inside
    // `middleware` then handles /login + /api/auth + the m2m exemption.
    "/((?!_next/static|_next/image|favicon.ico|api/health).*)",
  ],
};
