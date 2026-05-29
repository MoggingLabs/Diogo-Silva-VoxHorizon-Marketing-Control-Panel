/**
 * POST /api/auth/logout — clear the single-operator session cookie.
 *
 * Idempotent: clearing an already-absent cookie is a no-op 200. We expire the
 * cookie by setting it with `maxAge: 0` and the same attributes the login
 * route used (path/httpOnly/sameSite/secure) so the browser drops it.
 *
 * POST (not GET) so a cross-site `<img>`/link cannot silently log the operator
 * out, and so it pairs with the SameSite=Lax cookie semantics.
 */
import { NextResponse } from "next/server";

import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return res;
}
