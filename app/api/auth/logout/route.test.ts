/**
 * Tests for POST /api/auth/logout.
 *
 * Logout expires the session cookie (maxAge 0) with the same attributes the
 * login route set, and always returns 200 (idempotent).
 */
import { describe, expect, it } from "vitest";

import { POST } from "./route";
import { SESSION_COOKIE } from "@/lib/auth/session";

describe("POST /api/auth/logout", () => {
  it("200 and expires the session cookie", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const cleared = res.cookies.get(SESSION_COOKIE);
    expect(cleared?.value).toBe("");
    expect(cleared?.maxAge).toBe(0);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain("httponly");
  });
});
