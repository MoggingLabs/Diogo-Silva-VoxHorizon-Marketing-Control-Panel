/**
 * Tiny shared time-formatting helpers. Dependency-free so they can run in
 * server, client, and edge contexts without bundling anything.
 */

/**
 * Coarse "time since" formatter — picks the largest sensible unit and
 * returns e.g. "just now", "12m ago", "3h ago", "2d ago", "4mo ago".
 *
 * Used by the variants grid and iteration thread (both image + video).
 * Returns "—" on invalid input so callers don't need to guard for NaN.
 */
export function timeSince(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  try {
    const then = typeof iso === "string" ? new Date(iso).getTime() : iso.getTime();
    if (!Number.isFinite(then)) return "—";
    const diffMs = Date.now() - then;
    if (diffMs < 0) return "just now";
    const m = Math.floor(diffMs / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    const mo = Math.floor(d / 30);
    return `${mo}mo ago`;
  } catch {
    return "—";
  }
}

/**
 * Format a number of seconds as `MM:SS` (e.g. `01:23`). Returns `"—"` for
 * null / NaN. Useful for displaying audio/video durations next to scrubbers.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/**
 * Format an absolute timestamp using the user's locale. Returns `null` for
 * missing input so callers can show "—" or skip the line entirely.
 */
export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
