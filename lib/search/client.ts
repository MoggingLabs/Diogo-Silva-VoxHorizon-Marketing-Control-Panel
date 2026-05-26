/**
 * Browser-side fetch wrapper for the global search aggregator (`/api/search`),
 * which powers the cmd-k command palette (Makeover M7 / efficiency layer).
 *
 * The route fans out across clients / briefs / creatives / launches / pipelines
 * and returns a small capped `{ kind, id, label, href }[]`. This helper keeps
 * the React component free of fetch/JSON plumbing so it can be unit-tested in
 * isolation (mock `fetch`) and the palette just renders results.
 */

/** The kinds the search aggregator can return (mirrors `app/api/search`). */
export type SearchResultKind =
  | "client"
  | "brief"
  | "video_brief"
  | "creative"
  | "video_creative"
  | "launch_package"
  | "video_launch_package"
  | "pipeline";

export type SearchResult = {
  kind: SearchResultKind;
  id: string;
  label: string;
  href: string;
};

/** Human label + grouping order for each kind in the palette. */
export const SEARCH_KIND_LABEL: Record<SearchResultKind, string> = {
  client: "Clients",
  brief: "Briefs",
  video_brief: "Briefs",
  creative: "Creatives",
  video_creative: "Creatives",
  launch_package: "Launches",
  video_launch_package: "Launches",
  pipeline: "Pipelines",
};

/**
 * Fetch search results for a query. Returns `[]` for a blank query without a
 * network call (the route would too, but skipping the request keeps the palette
 * snappy and avoids a flash). An `AbortSignal` lets the caller cancel an
 * in-flight request when the query changes (debounce / race protection).
 *
 * Throws on a non-2xx response so the caller can surface an error state; an
 * aborted request rejects with the standard `AbortError`, which callers ignore.
 */
export async function searchResources(q: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const trimmed = q.trim();
  if (trimmed.length === 0) return [];

  const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Search failed (${res.status})`);
  }
  const body = (await res.json()) as { results?: SearchResult[] };
  return body.results ?? [];
}

/**
 * Group a flat result list into palette sections keyed by the display label,
 * preserving the order results arrived in (the route already interleaves by
 * kind). Returns an array of `{ heading, items }` so the renderer can map it
 * directly to `<CommandGroup>`s.
 */
export function groupSearchResults(
  results: SearchResult[],
): { heading: string; items: SearchResult[] }[] {
  const order: string[] = [];
  const byHeading = new Map<string, SearchResult[]>();
  for (const r of results) {
    const heading = SEARCH_KIND_LABEL[r.kind];
    let bucket = byHeading.get(heading);
    if (!bucket) {
      bucket = [];
      byHeading.set(heading, bucket);
      order.push(heading);
    }
    bucket.push(r);
  }
  return order.map((heading) => ({ heading, items: byHeading.get(heading)! }));
}
