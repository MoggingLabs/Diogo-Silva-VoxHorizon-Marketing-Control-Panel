/**
 * Tests for POST /api/auth/login (single-operator session login).
 *
 * Coverage targets:
 *   - 200: good creds -> sets the HttpOnly session cookie + returns the email.
 *   - 401: wrong password -> generic invalid_credentials, no cookie.
 *   - 401: unknown email  -> SAME generic 401 (no user-enumeration leak).
 *   - 401: a malformed stored hash makes bcrypt throw -> treated as a failure.
 *   - 400: malformed JSON body.
 *   - 422: body fails the zod schema.
 *   - 503: SESSION_SECRET unset (cannot mint a verifiable cookie).
 *
 * `lib/auth/operator` (service-role DB read) and `bcryptjs` are mocked at the
 * module boundary so no real Supabase / hashing runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/operator", () => ({
  findOperatorByEmail: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  compare: vi.fn(),
}));

import { compare } from "bcryptjs";
import { findOperatorByEmail } from "@/lib/auth/operator";

import { POST } from "./route";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

const SECRET = "route-test-session-secret";

const OPERATOR = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "operator@example.com",
  password_hash: "$2a$10$abcdefghijklmnopqrstuv",
};

function loginReq(body: unknown): import("next/server").NextRequest {
  const init: RequestInit =
    typeof body === "string"
      ? { method: "POST", body, headers: { "content-type": "application/json" } }
      : {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        };
  return new Request(
    "http://localhost/api/auth/login",
    init,
  ) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.mocked(findOperatorByEmail).mockReset();
  vi.mocked(compare).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/auth/login", () => {
  it("200 + sets a verifiable session cookie on good credentials", async () => {
    vi.mocked(findOperatorByEmail).mockResolvedValue(OPERATOR);
    vi.mocked(compare).mockResolvedValue(true as never);

    const res = await POST(loginReq({ email: "Operator@Example.com", password: "hunter2" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.email).toBe("operator@example.com");

    // The Set-Cookie carries the session cookie with HttpOnly.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain("httponly");

    // The minted token actually verifies under the configured secret.
    const token = res.cookies.get(SESSION_COOKIE)?.value;
    const payload = await verifySessionToken(token);
    expect(payload?.email).toBe("operator@example.com");

    // The lookup was performed against the lowercased email.
    expect(findOperatorByEmail).toHaveBeenCalledWith("operator@example.com");
  });

  it("401 invalid_credentials on a wrong password (no cookie set)", async () => {
    vi.mocked(findOperatorByEmail).mockResolvedValue(OPERATOR);
    vi.mocked(compare).mockResolvedValue(false as never);

    const res = await POST(loginReq({ email: "operator@example.com", password: "wrong" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_credentials");
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("401 invalid_credentials on an unknown email (same shape, no enumeration)", async () => {
    vi.mocked(findOperatorByEmail).mockResolvedValue(null);

    const res = await POST(loginReq({ email: "nobody@example.com", password: "whatever" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_credentials");
    expect(compare).not.toHaveBeenCalled();
  });

  it("401 when bcrypt.compare throws on a malformed stored hash", async () => {
    vi.mocked(findOperatorByEmail).mockResolvedValue(OPERATOR);
    vi.mocked(compare).mockRejectedValue(new Error("invalid hash") as never);

    const res = await POST(loginReq({ email: "operator@example.com", password: "x" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_credentials");
  });

  it("400 on malformed JSON body", async () => {
    const res = await POST(loginReq("{not json"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });

  it("422 when the body fails validation", async () => {
    const res = await POST(loginReq({ email: "", password: "" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("validation_failed");
  });

  it("503 when SESSION_SECRET is not configured", async () => {
    vi.unstubAllEnvs();
    const res = await POST(loginReq({ email: "operator@example.com", password: "x" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("session_not_configured");
  });
});
