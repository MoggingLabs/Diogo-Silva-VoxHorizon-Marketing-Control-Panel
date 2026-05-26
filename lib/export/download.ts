/**
 * Browser file-download helper for client-side exports (Makeover M7).
 *
 * Kept tiny and separate from the pure serializers in `lib/export/csv.ts` so
 * that module stays environment-free. This one touches `document` / `URL`, so
 * it only runs in the browser; it's exercised in jsdom-backed component tests.
 */

/** MIME types for the two export formats the bulk bar offers. */
export const EXPORT_MIME = {
  csv: "text/csv;charset=utf-8",
  json: "application/json;charset=utf-8",
} as const;

export type ExportFormat = keyof typeof EXPORT_MIME;

/**
 * Trigger a client-side download of `content` as a file named `filename` with
 * the given MIME type. Creates a Blob + object URL, clicks a transient anchor,
 * then revokes the URL. No-ops outside the browser (SSR safety).
 */
export function downloadTextFile(filename: string, content: string, mime: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  // Some browsers require the element to be in the DOM for the click to count.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Compose a stable, filesystem-safe export filename like
 * `clients-2026-05-26.csv`. The date is the local day (YYYY-MM-DD); `base` is
 * slugified so a resource label with spaces/punctuation stays safe.
 */
export function exportFilename(base: string, format: ExportFormat, now: Date = new Date()): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "export";
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${slug}-${y}-${m}-${d}.${format}`;
}
