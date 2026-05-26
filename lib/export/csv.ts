/**
 * Client-side data export helpers (Makeover M7 / efficiency layer).
 *
 * The bulk-action bar can export the selected rows as CSV or JSON without a
 * round trip — the rows are already in memory. These are pure
 * (string-in/string-out) so they're trivially unit-testable; the actual
 * browser download lives in `lib/export/download.ts`.
 */

/** A row is any flat record of primitive-ish cell values. */
export type ExportRow = Record<string, unknown>;

/**
 * Render a single cell for CSV. `null`/`undefined` become empty; objects are
 * JSON-stringified so a stray nested value doesn't print `[object Object]`.
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Quote a CSV field per RFC 4180: wrap in double quotes when it contains a
 * comma, quote, CR or LF, and double any embedded quotes. Plain values pass
 * through unquoted so the output stays human-readable.
 */
function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export type CsvColumn<T> = {
  /** Header cell text. */
  header: string;
  /** Pull the cell value out of a row. */
  value: (row: T) => unknown;
};

/**
 * Serialize rows to a CSV string with a header line. Uses CRLF line endings
 * (the RFC 4180 + spreadsheet-friendly default). An empty `rows` array still
 * emits the header row so the file isn't blank.
 */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const headerLine = columns.map((c) => escapeCsvField(c.header)).join(",");
  const dataLines = rows.map((row) =>
    columns.map((c) => escapeCsvField(cellToString(c.value(row)))).join(","),
  );
  return [headerLine, ...dataLines].join("\r\n");
}

/**
 * Serialize rows to a pretty-printed JSON array string. When `columns` is
 * supplied each row is projected to `{ header: value }` so the JSON export
 * matches the CSV's shape/labels; otherwise the raw rows are emitted as-is.
 */
export function toJson<T>(rows: T[], columns?: CsvColumn<T>[]): string {
  if (!columns) return JSON.stringify(rows, null, 2);
  const projected = rows.map((row) => {
    const out: ExportRow = {};
    for (const c of columns) out[c.header] = c.value(row);
    return out;
  });
  return JSON.stringify(projected, null, 2);
}
