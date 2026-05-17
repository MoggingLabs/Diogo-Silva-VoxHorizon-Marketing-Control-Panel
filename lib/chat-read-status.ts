/**
 * Per-creative chat read-status helpers.
 *
 * Tracks the "last seen" timestamp for each creative thread so the UI
 * can render an Unread Divider above messages that arrived after the
 * operator's last visit. Persists to `localStorage` as a placeholder
 * while Agent CS migrates the real `chat_read_status` table; the public
 * API is intentionally async + Promise-returning so the swap-over is a
 * one-line change.
 *
 * Storage shape:
 *   localStorage["voxhorizon.chat.lastSeen.v1"] = JSON object:
 *     { [creativeId: string]: ISO string }
 *
 * `markRead(creativeId)` stamps the current wall-clock as last-seen.
 * `getLastSeen(creativeId)` returns the stamp (or `null` on first
 * visit). `getUnreadCount(creativeId, messages)` counts how many
 * messages in the supplied list are newer than the stamp — handy for a
 * one-shot count on render.
 */

const STORAGE_KEY = "voxhorizon.chat.lastSeen.v1";

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readMap(): Record<string, string> {
  const ls = safeStorage();
  if (!ls) return {};
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, string>;
    }
  } catch {
    // Corrupt blob — pretend it's empty and overwrite on next write.
  }
  return {};
}

function writeMap(map: Record<string, string>): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota / private-mode — silently drop. Worst case is the unread
    // divider stays stuck; it's not load-bearing for correctness.
  }
}

/**
 * Return the last "seen" timestamp for the given creative, or `null`
 * if the operator has never marked it read.
 */
export async function getLastSeen(creativeId: string): Promise<string | null> {
  if (!creativeId) return null;
  const map = readMap();
  return map[creativeId] ?? null;
}

/**
 * Stamp `now()` (or the supplied ISO string) as the last-seen marker
 * for the given creative. Fires a POST to `/api/chat-read-status` so
 * the server side can persist when the table is wired; the local
 * stamp lands first to keep the UI snappy.
 */
export async function markRead(creativeId: string, isoTimestamp?: string): Promise<void> {
  if (!creativeId) return;
  const at = isoTimestamp ?? new Date().toISOString();
  const map = readMap();
  map[creativeId] = at;
  writeMap(map);
  // Fire-and-forget — server persistence is best-effort while the
  // table is still placeholder. We avoid await to keep the click
  // handler instant; failures are logged inside the fetch.
  void postReadStatus(creativeId, at);
}

async function postReadStatus(creativeId: string, at: string): Promise<void> {
  try {
    await fetch("/api/chat-read-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creative_id: creativeId, last_read_at: at }),
      keepalive: true,
    });
  } catch {
    // The endpoint is a stub today; failures are non-fatal.
  }
}

/**
 * Count how many of the supplied messages were created strictly after
 * `lastSeen`. If `lastSeen` is null (first visit) we treat ALL messages
 * as read — the divider only makes sense once the operator has been
 * there at least once.
 */
export function countUnread<M extends { createdAt: string }>(
  lastSeen: string | null,
  messages: M[],
): number {
  if (!lastSeen) return 0;
  const cutoff = new Date(lastSeen).getTime();
  if (!Number.isFinite(cutoff)) return 0;
  let n = 0;
  for (const m of messages) {
    const t = new Date(m.createdAt).getTime();
    if (Number.isFinite(t) && t > cutoff) n++;
  }
  return n;
}

/**
 * Return the index in `messages` of the first item created strictly
 * after `lastSeen`, or `-1` if every message is at-or-before. Used to
 * decide where to insert the `<UnreadDivider />` in render order.
 */
export function firstUnreadIndex<M extends { createdAt: string }>(
  lastSeen: string | null,
  messages: M[],
): number {
  if (!lastSeen) return -1;
  const cutoff = new Date(lastSeen).getTime();
  if (!Number.isFinite(cutoff)) return -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    const t = new Date(m.createdAt).getTime();
    if (Number.isFinite(t) && t > cutoff) return i;
  }
  return -1;
}
