import { NextResponse, type NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Buckets the relay is allowed to sign for. Only `creatives` exists today. */
const ALLOWED_BUCKETS = new Set(["creatives"]);

/** Clamp the signed-URL TTL to a sane range (1 min … 24 h). */
const MIN_TTL_S = 60;
const MAX_TTL_S = 86_400;
const DEFAULT_TTL_S = 3_600;

/** Bound the batch so a single request can't ask us to sign thousands of paths. */
const MAX_PATHS = 100;

type SignRequest = {
  bucket?: unknown;
  paths?: unknown;
  expiresIn?: unknown;
};

/**
 * POST /api/storage/sign
 *
 * Mints short-lived signed URLs for private Supabase Storage objects using the
 * service-role client. Replaces the client-side `supabase.storage.createSignedUrl`
 * calls that stopped working once the anon role lost access (storage.objects
 * has RLS enabled with no anon policy). Gated by Caddy basic auth.
 *
 * Body: `{ bucket: "creatives", paths: string[], expiresIn?: seconds }`
 * Returns: `{ urls: Record<path, string | null> }` — `null` for paths that
 * failed to sign (missing object, etc.), so callers can fall back to a
 * placeholder per-path without the whole batch failing.
 */
export async function POST(req: NextRequest) {
  let body: SignRequest;
  try {
    body = (await req.json()) as SignRequest;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const bucket = typeof body.bucket === "string" ? body.bucket : "";
  if (!ALLOWED_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: "invalid_bucket" }, { status: 400 });
  }

  const rawPaths = Array.isArray(body.paths) ? body.paths : null;
  if (!rawPaths) {
    return NextResponse.json({ error: "invalid_paths" }, { status: 400 });
  }
  const paths = Array.from(
    new Set(rawPaths.filter((p): p is string => typeof p === "string" && p.length > 0)),
  );
  if (paths.length === 0) {
    return NextResponse.json({ urls: {} });
  }
  if (paths.length > MAX_PATHS) {
    return NextResponse.json({ error: "too_many_paths", max: MAX_PATHS }, { status: 400 });
  }

  let expiresIn = DEFAULT_TTL_S;
  if (typeof body.expiresIn === "number" && Number.isFinite(body.expiresIn)) {
    expiresIn = Math.min(Math.max(Math.floor(body.expiresIn), MIN_TTL_S), MAX_TTL_S);
  }

  const supabase = createAdminClient();
  const urls: Record<string, string | null> = {};

  // `createSignedUrls` (plural) signs a batch in one round-trip and returns a
  // per-path result array, which is exactly the shape we want to relay.
  const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, expiresIn);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  for (const entry of data ?? []) {
    if (entry.path) {
      urls[entry.path] = entry.signedUrl ?? null;
    }
  }
  // Ensure every requested path has a key even if the API omitted it.
  for (const p of paths) {
    if (!(p in urls)) urls[p] = null;
  }

  return NextResponse.json({ urls });
}
