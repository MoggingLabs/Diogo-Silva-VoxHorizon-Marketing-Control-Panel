import "server-only";

import { NextResponse } from "next/server";
import type { ZodError } from "zod";

/**
 * Shared JSON response + error helpers for the reusable CRUD stack (E1.1 / #583).
 *
 * Every resource route (M2+) reuses these so the wire contract is identical
 * across surfaces: the same error envelope shape and the same status-code map.
 * Mirrors the conventions already established by the canonical routes
 * (`app/api/briefs/[id]/route.ts`, `app/api/pipelines/*`):
 *
 *   - validation failures -> 400 `{ error: "validation_failed", issues }`
 *   - missing row         -> 404 `{ error: "not_found" }`
 *   - compare-and-set loss -> 409 `{ error, ...detail }`
 *   - unexpected DB error  -> 500 `{ error: <message> }`
 *
 * Note on the zod status: the canonical brief route returns 400 on zod failure
 * while the pipeline list/create routes return 422. The plan pins the shared
 * helper to **400** (the canonical brief route), so new resource routes are
 * consistent with each other; the legacy pipeline routes keep their own status.
 */

export const runtime = "nodejs";

/** A 200 OK JSON response. */
export function ok<T>(body: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, { status: 200, ...init });
}

/** A 201 Created JSON response (resource POST). */
export function created<T>(body: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, { status: 201, ...init });
}

/**
 * 400 from a zod parse failure. Pass the `ZodError` (e.g.
 * `parsed.error`); the issue list is surfaced so the client can map errors to
 * fields. Shape matches the canonical brief PATCH route.
 */
export function zodError(error: ZodError): NextResponse {
  return NextResponse.json({ error: "validation_failed", issues: error.issues }, { status: 400 });
}

/** 400 for a malformed request body that is not even valid JSON. */
export function badJson(): NextResponse {
  return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
}

/** 400 with a free-form message (e.g. "nothing to update"). */
export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** 404 for a missing / already-removed row. */
export function notFound(message = "not_found"): NextResponse {
  return NextResponse.json({ error: message }, { status: 404 });
}

/**
 * 409 for a compare-and-set conflict (the row moved under us, or a unique
 * constraint collided). Extra `detail` keys (e.g. `{ from, to }`) are merged
 * into the envelope so the client can show the current state.
 */
export function conflict(message: string, detail: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error: message, ...detail }, { status: 409 });
}

/**
 * 500 from an unexpected backend error. Accepts a Supabase/Postgrest error
 * object, an `Error`, or a string; falls back to a generic message.
 */
export function serverError(error: { message?: string } | string | null | undefined): NextResponse {
  const message = typeof error === "string" ? error : (error?.message ?? "internal_error");
  return NextResponse.json({ error: message }, { status: 500 });
}
