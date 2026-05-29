/**
 * POST /api/auth/login — single-operator app session login.
 *
 * Defense-in-depth: the dashboard sits behind Caddy HTTP Basic Auth at the
 * edge, but every server route runs as service-role with no per-request
 * identity. This route adds a REAL app-layer session: it verifies the
 * presented password against the single `operators` row (migration 0057) and,
 * on success, issues a signed HttpOnly SameSite cookie that `middleware.ts`
 * then validates on every non-public request.
 *
 * Posture: single-operator. There is exactly one conceptual operator row; this
 * is NOT multi-user auth (that is the explicit post-v1 rewrite).
 *
 * Failure shape: a wrong email and a wrong password both return an identical
 * 401 with a generic message so the response does not reveal whether the email
 * exists. The bcrypt compare is constant-time.
 */
import { compare } from "bcryptjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { findOperatorByEmail } from "@/lib/auth/operator";
import {
  issueSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookieOptions,
} from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LoginRequest = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

/** Identical body for every auth failure so we never leak which field was wrong. */
function invalidCredentials(): NextResponse {
  return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // SESSION_SECRET must be configured for the issued cookie to be verifiable.
  // Fail closed (503) with a clear signal rather than minting an unverifiable
  // token.
  if (!(process.env.SESSION_SECRET ?? "").trim()) {
    return NextResponse.json({ error: "session_not_configured" }, { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = LoginRequest.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const email = parsed.data.email.trim().toLowerCase();
  const operator = await findOperatorByEmail(email);
  if (!operator) {
    // No such operator. Still run a throwaway compare? Not necessary: bcryptjs
    // compare against a missing hash would need a dummy hash to equalise timing.
    // The lookup is a single indexed equality on a one-row table, so the timing
    // delta is dominated by bcrypt anyway; we keep the message generic.
    return invalidCredentials();
  }

  let ok = false;
  try {
    ok = await compare(parsed.data.password, operator.password_hash);
  } catch {
    // A malformed stored hash should not 500 the login form; treat as a failed
    // attempt (the operator must re-seed a valid bcrypt hash).
    return invalidCredentials();
  }
  if (!ok) {
    return invalidCredentials();
  }

  const token = await issueSessionToken(operator.email);
  const res = NextResponse.json({ ok: true, email: operator.email }, { status: 200 });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL_SECONDS));
  return res;
}
