/**
 * Browser-side data helpers for the post-RLS-lockdown dashboard.
 *
 * After Phase 2, the browser can no longer read Supabase directly (RLS
 * deny-all blocks the anon key) or mint storage signed URLs (storage.objects
 * RLS has no anon policy). These helpers replace the in-component
 * `supabase.from(...).select(...)` / `supabase.storage.createSignedUrl(...)`
 * calls with `fetch()`es to the corresponding service-role API routes, which
 * are gated by Caddy basic auth.
 *
 * All helpers fail soft where the previous client code did: signing returns a
 * per-path map (null on failure) so a missing object never breaks the batch.
 */

/**
 * Sign a batch of private Storage paths via `POST /api/storage/sign`.
 * Returns a `path → signedUrl | null` map. On a transport/HTTP error every
 * requested path maps to `null` (callers render placeholders), matching the
 * old fail-closed try/catch behaviour.
 */
export async function signStoragePaths(
  bucket: string,
  paths: string[],
  expiresIn?: number,
): Promise<Record<string, string | null>> {
  const unique = Array.from(new Set(paths.filter(Boolean)));
  if (unique.length === 0) return {};
  try {
    const res = await fetch("/api/storage/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ bucket, paths: unique, expiresIn }),
    });
    if (!res.ok) {
      return Object.fromEntries(unique.map((p) => [p, null]));
    }
    const body = (await res.json()) as { urls?: Record<string, string | null> };
    const urls = body.urls ?? {};
    // Guarantee a key per requested path.
    for (const p of unique) {
      if (!(p in urls)) urls[p] = null;
    }
    return urls;
  } catch {
    return Object.fromEntries(unique.map((p) => [p, null]));
  }
}

/** Convenience: sign a single path. Returns the URL or null. */
export async function signStoragePath(
  bucket: string,
  path: string,
  expiresIn?: number,
): Promise<string | null> {
  const map = await signStoragePaths(bucket, [path], expiresIn);
  return map[path] ?? null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export type ClientOption = {
  id: string;
  name: string;
  slug: string;
  service_type: string;
  status?: string;
};

/** Fetch clients for the brief/pipeline pickers (active-first, then by name). */
export async function fetchClients(): Promise<ClientOption[]> {
  const body = await getJson<{ clients?: ClientOption[] }>("/api/clients");
  return body.clients ?? [];
}

/** Fetch the iteration thread for an image creative (oldest first). */
export async function fetchCreativeIterations<T>(creativeId: string): Promise<T[]> {
  const body = await getJson<{ iterations?: T[] }>(
    `/api/creatives/${encodeURIComponent(creativeId)}/iterations`,
  );
  return body.iterations ?? [];
}

/** Fetch the iteration thread for a video creative (oldest first). */
export async function fetchVideoIterations<T>(creativeId: string): Promise<T[]> {
  const body = await getJson<{ iterations?: T[] }>(
    `/api/creatives/video/${encodeURIComponent(creativeId)}/iterations`,
  );
  return body.iterations ?? [];
}

/** Fetch image creatives for a brief (ideation), oldest first. */
export async function fetchCreativesByBrief<T>(briefId: string): Promise<T[]> {
  const body = await getJson<{ creatives?: T[] }>(
    `/api/creatives?brief_id=${encodeURIComponent(briefId)}`,
  );
  return body.creatives ?? [];
}

/** Fetch image creatives by an explicit id set (review picks). */
export async function fetchCreativesByIds<T>(ids: string[]): Promise<T[]> {
  if (ids.length === 0) return [];
  const body = await getJson<{ creatives?: T[] }>(
    `/api/creatives?ids=${encodeURIComponent(ids.join(","))}`,
  );
  return body.creatives ?? [];
}

/** Fetch video creatives for a brief (ideation / done), oldest first. */
export async function fetchVideoCreativesByBrief<T>(briefId: string): Promise<T[]> {
  const body = await getJson<{ creatives?: T[] }>(
    `/api/creatives/video?brief_id=${encodeURIComponent(briefId)}`,
  );
  return body.creatives ?? [];
}

/**
 * Fetch video creatives by id set, plus a `brief_id → script_outline` map for
 * the review picks grid. Mirrors the old two-hop client read.
 */
export async function fetchVideoCreativesByIdsWithOutline<T>(
  ids: string[],
): Promise<{ creatives: T[]; outlines: Record<string, unknown> }> {
  if (ids.length === 0) return { creatives: [], outlines: {} };
  const body = await getJson<{ creatives?: T[]; outlines?: Record<string, unknown> }>(
    `/api/creatives/video?ids=${encodeURIComponent(ids.join(","))}&with_outline=1`,
  );
  return { creatives: body.creatives ?? [], outlines: body.outlines ?? {} };
}
