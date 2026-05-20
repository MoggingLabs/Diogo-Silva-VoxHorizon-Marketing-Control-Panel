/**
 * Shared (server + client) contract for the server-side Realtime SSE relay.
 *
 * Phase 2 of the Supabase lockdown enabled RLS deny-all on every public
 * table, so the browser's anon key can no longer receive `postgres_changes`
 * over Supabase Realtime. Instead, the Next.js server holds the Realtime
 * subscription with the service-role credential (which bypasses RLS) and
 * relays change events to the browser as Server-Sent Events, gated by the
 * Caddy basic-auth edge.
 *
 * This module defines:
 *  - `RealtimeChangeEvent` — the shape the browser receives per change. It is
 *    deliberately close to Supabase's `postgres_changes` payload
 *    (`{ eventType, table, new, old }`) so component callbacks barely change.
 *  - `RealtimeSubscriptionSpec` — one table/event(/filter) the client wants.
 *  - `SUBSCRIBABLE_TABLES` — the allowlist the SSE route validates against.
 *  - `encodeSubs` / `parseSubs` — (de)serialise specs through the `?subs=`
 *    query param so the client can declare exactly what it cares about.
 */

/** The Postgres change events Supabase Realtime can deliver. */
export type RealtimeEventType = "INSERT" | "UPDATE" | "DELETE" | "*";

/**
 * A single subscription request: "tell me about <event> on <table>,
 * optionally filtered". `filter` uses Supabase's Realtime filter syntax,
 * e.g. `pipeline_id=eq.<uuid>` or `id=eq.<uuid>`.
 */
export type RealtimeSubscriptionSpec = {
  table: string;
  event: RealtimeEventType;
  filter?: string;
};

/**
 * The event the SSE relay streams to the browser for each change. Mirrors
 * the fields component callbacks read from Supabase's native payload.
 */
export type RealtimeChangeEvent = {
  /** The table the change happened on. */
  table: string;
  /** The concrete event (never `*` — that's only a subscription wildcard). */
  eventType: "INSERT" | "UPDATE" | "DELETE";
  /** The new row (INSERT/UPDATE), or `{}` for DELETE. */
  new: Record<string, unknown>;
  /** The old row (DELETE, and UPDATE when replica identity is full). */
  old: Record<string, unknown>;
};

/**
 * Tables the relay is allowed to subscribe to. This is the union of:
 *  - every table on the `supabase_realtime` publication (migration 0002 +
 *    0006 pipelines + 0009 approval_mode), and
 *  - `events`, which is NOT on the publication but is subscribed with an
 *    explicit `ref_id` filter by the brief/launch timelines (Supabase allows
 *    filtered postgres_changes subscriptions on unpublished tables).
 *
 * The SSE route rejects any requested table not in this set, so a compromised
 * or buggy client cannot ask the service-role relay to stream an arbitrary
 * table.
 */
export const SUBSCRIBABLE_TABLES = new Set<string>([
  // publication (0002)
  "briefs",
  "creatives",
  "creative_iterations",
  "copy_variants",
  "launch_packages",
  "video_briefs",
  "video_creatives",
  "video_iterations",
  "video_copy_variants",
  "video_launch_packages",
  "campaign_perf_image",
  "campaign_perf_video",
  "overrides",
  // publication (0006 / 0007)
  "pipelines",
  "pipeline_events",
  // publication (0008 hermes, 0009 approvals/approval_mode)
  "hermes_tasks",
  "approvals",
  "approvals_policy_cache",
  "approval_mode",
  "chat_messages",
  // filtered-only consumer (VideoBriefTimeline)
  "events",
]);

const VALID_EVENTS: ReadonlySet<string> = new Set(["INSERT", "UPDATE", "DELETE", "*"]);

/**
 * Type guard for a single spec coming off the wire. Validates the table is on
 * the allowlist and the event is a known value. `filter` (when present) must
 * be a string; we do not parse it further — Supabase validates it and the
 * service-role subscription is read-only.
 */
export function isValidSpec(value: unknown): value is RealtimeSubscriptionSpec {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.table !== "string" || !SUBSCRIBABLE_TABLES.has(v.table)) return false;
  if (typeof v.event !== "string" || !VALID_EVENTS.has(v.event)) return false;
  if (v.filter !== undefined && typeof v.filter !== "string") return false;
  return true;
}

/**
 * Serialise specs into a single URL-safe query-param value. We base64url-
 * encode the JSON so filters containing `=` / `,` survive the query string
 * intact and the value is compact.
 */
export function encodeSubs(specs: RealtimeSubscriptionSpec[]): string {
  const json = JSON.stringify(specs);
  // btoa exists in both the browser and the Node runtime used by the route.
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Parse the `?subs=` value back into a validated spec list. Returns `[]` for
 * anything malformed or empty — the route treats an empty spec list as a bad
 * request, and the hook never sends one.
 */
export function parseSubs(raw: string | null): RealtimeSubscriptionSpec[] {
  if (!raw) return [];
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(b64)));
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const specs = parsed.filter(isValidSpec);
    return specs;
  } catch {
    return [];
  }
}
