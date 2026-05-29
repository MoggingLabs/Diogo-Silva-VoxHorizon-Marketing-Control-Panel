import { hash } from "bcryptjs";

import { test, expect, getTestAdminClient } from "./_fixtures";
import { SESSION_COOKIE } from "@/lib/auth/session";

/**
 * Single-operator session gate — end-to-end (Part C).
 *
 * The shared fixture injects a valid session cookie so the rest of the suite
 * runs behind the gate without walking the form. This spec proves the two
 * pieces the fixture takes on faith:
 *
 *   1. The GATE redirects an UNAUTHENTICATED page request to /login (we clear
 *      the fixture cookie first), and 401s a gated /api/* call.
 *   2. The LOGIN FORM authenticates: seeding a real operator row + posting the
 *      right password sets the session cookie and lands the operator on the
 *      dashboard.
 */

const LOGIN_OPERATOR_EMAIL = "e2e-login@voxhorizon.test";
const LOGIN_OPERATOR_PASSWORD = "correct-horse-battery-staple";

async function seedOperator(): Promise<void> {
  const admin = getTestAdminClient();
  const password_hash = await hash(LOGIN_OPERATOR_PASSWORD, 10);
  // Idempotent: upsert on the unique email so reruns reuse the row.
  const { error } = await admin.from("operators" as never).upsert(
    { email: LOGIN_OPERATOR_EMAIL, password_hash } as never,
    {
      onConflict: "email",
    } as never,
  );
  if (error) throw new Error(`seedOperator failed: ${error.message}`);
}

async function removeOperator(): Promise<void> {
  const admin = getTestAdminClient();
  await admin
    .from("operators" as never)
    .delete()
    .eq("email" as never, LOGIN_OPERATOR_EMAIL as never);
}

test.describe("single-operator session gate", () => {
  test("redirects an unauthenticated page request to /login and 401s a gated api call", async ({
    page,
    context,
  }) => {
    // Drop the fixture-injected cookie so this is a genuine anonymous request.
    await context.clearCookies();

    await page.goto("/pipeline");
    await expect(page).toHaveURL(/\/login(\?|$)/);
    // The original destination is preserved for post-login return.
    await expect(page).toHaveURL(/next=%2Fpipeline/);

    // A gated API route returns 401 JSON (not an HTML redirect) when anonymous.
    const res = await page.request.get("/api/pipelines", { maxRedirects: 0 });
    expect(res.status()).toBe(401);
  });

  test("login form authenticates and lands on the dashboard", async ({ page, context }) => {
    await seedOperator();
    try {
      // Start anonymous so the form is the thing that authenticates us.
      await context.clearCookies();

      await page.goto("/login");
      await page.getByLabel(/email/i).fill(LOGIN_OPERATOR_EMAIL);
      await page.getByLabel(/password/i).fill(LOGIN_OPERATOR_PASSWORD);
      await page.getByRole("button", { name: /sign in/i }).click();

      // Redirected off /login (default destination is the dashboard root).
      await expect(page).toHaveURL(/\/$|\/\?/, { timeout: 15_000 });

      // The HttpOnly session cookie is now set on the context.
      const cookies = await context.cookies();
      expect(cookies.some((c) => c.name === SESSION_COOKIE && c.value.length > 0)).toBe(true);
    } finally {
      await removeOperator();
    }
  });
});
