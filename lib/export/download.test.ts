/**
 * Unit tests for the export download helpers (Makeover M7).
 *
 * `exportFilename` is pure and fully covered here. `downloadTextFile`'s DOM
 * path runs in the browser, so this node-environment suite exercises the SSR
 * guard (document undefined -> no-op); the happy path is covered by the
 * BulkExportButton component test under jsdom.
 */
import { describe, expect, it } from "vitest";

import { downloadTextFile, EXPORT_MIME, exportFilename } from "./download";

describe("exportFilename", () => {
  const fixedDate = new Date(2026, 4, 7); // 2026-05-07 (month is 0-based)

  it("slugifies the base and appends a zero-padded date + extension", () => {
    expect(exportFilename("Clients", "csv", fixedDate)).toBe("clients-2026-05-07.csv");
    expect(exportFilename("clients", "json", fixedDate)).toBe("clients-2026-05-07.json");
  });

  it("collapses non-alphanumerics and trims leading/trailing dashes", () => {
    expect(exportFilename("  Launch Packages! ", "csv", fixedDate)).toBe(
      "launch-packages-2026-05-07.csv",
    );
  });

  it("falls back to 'export' when the base has no usable characters", () => {
    expect(exportFilename("!!!", "json", fixedDate)).toBe("export-2026-05-07.json");
  });

  it("uses the current date when none is supplied", () => {
    const name = exportFilename("x", "csv");
    expect(name).toMatch(/^x-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("exposes the expected MIME types", () => {
    expect(EXPORT_MIME.csv).toContain("text/csv");
    expect(EXPORT_MIME.json).toContain("application/json");
  });
});

describe("downloadTextFile (SSR guard)", () => {
  it("is a no-op when document is undefined", () => {
    // In the node test environment `document` is undefined, so this must not
    // throw (it returns early before touching the DOM).
    expect(() => downloadTextFile("x.csv", "a,b", EXPORT_MIME.csv)).not.toThrow();
  });
});
