import type { BrowserContext } from "@playwright/test";

import { issueSessionToken, SESSION_COOKIE } from "@/lib/auth/session";

/**
 * E2E session-gate auth helper.
 *
 * The single-operator session gate (`middleware.ts`) now bounces every
 * unauthenticated page request to `/login` and 401s gated `/api/*` calls. The
 * Playwright specs drive the dashboard through `page.goto(...)`, so the browser
 * context must carry a VALID session cookie before any navigation or every
 * spec would land on the login screen.
 *
 * We do NOT walk the login FORM in every spec (that would couple 21 specs to
 * the login UI and slow them down). Instead we mint the same signed cookie the
 * login route issues and inject it into the browser context up front. The
 * middleware only verifies the cookie's signature + expiry (it does not read
 * the DB), so a correctly-signed token is sufficient — and it must be signed
 * with the SAME `SESSION_SECRET` the dev server runs with.
 *
 * `tests/e2e/auth-login.spec.ts` covers the real form end-to-end (the fixture
 * approach proves the gate lets a valid cookie through; the login spec proves
 * the form mints one).
 */

const E2E_OPERATOR_EMAIL = "e2e-operator@voxhorizon.test";

/**
 * The base URL the specs hit. Mirrors `playwright.config.ts`: an explicit
 * `PLAYWRIGHT_BASE_URL` (CI's pre-started prod server) or localhost:3000.
 */
export function e2eBaseUrl(): string {
  return process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
}

/**
 * Assert `SESSION_SECRET` is available to the test runner. The dev/prod server
 * Playwright talks to reads it from `.env.local`; the runner process must have
 * the SAME value so the cookie it signs verifies on the server. Fail fast with
 * a clear message (mirrors the SUPABASE_SECRET_KEY guard in `_fixtures.ts`).
 */
function requireSessionSecret(): void {
  if (!(process.env.SESSION_SECRET ?? "").trim()) {
    throw new Error(
      "SESSION_SECRET is required for e2e tests — the session gate is active and the " +
        "fixture signs a session cookie with it. Set it in .env.local (and export it into " +
        "the test runner's env) to the SAME value the dev/prod server uses.",
    );
  }
}

/**
 * Inject a valid single-operator session cookie into the browser context so
 * every subsequent `page.goto` passes the middleware gate. Called once per
 * test by the shared fixture before the test body runs.
 */
export async function seedSessionCookie(context: BrowserContext): Promise<void> {
  requireSessionSecret();
  const token = await issueSessionToken(E2E_OPERATOR_EMAIL);
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      url: e2eBaseUrl(),
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

/**
 * Cookie header carrying a valid single-operator session, for harness helpers
 * that drive Next API routes through the bare Node `fetch` rather than
 * `page.request`. `page.request` shares the browser context's
 * fixture-seeded cookie, so those calls are already authenticated; a bare
 * `fetch` is a separate client with no cookie jar, so the session gate
 * (`middleware.ts`) 401s it. Spread the returned header into the fetch's
 * `headers` to authenticate it the same way the browser would.
 */
export async function sessionCookieHeader(): Promise<Record<string, string>> {
  requireSessionSecret();
  const token = await issueSessionToken(E2E_OPERATOR_EMAIL);
  return { Cookie: `${SESSION_COOKIE}=${token}` };
}
