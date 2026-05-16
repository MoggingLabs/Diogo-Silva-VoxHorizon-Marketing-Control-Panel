import { z } from "zod";

/**
 * Operator overrides — a thin write-only layer on top of any table/row/field.
 *
 * The point: the operator can correct any single field on any row without
 * mutating the source table. Reads are then computed elsewhere as a left-join
 * (source row + overrides row), so the source data stays intact for audit /
 * re-ingest / debugging. The `overrides` table is created in M0-16's initial
 * schema with a unique constraint on `(table_name, row_id, field_name)`, so
 * a re-edit of the same field is a clean upsert.
 *
 * This module ships:
 *  - `OverrideInput`  — zod schema mirroring the POST /api/overrides body.
 *  - `OverrideClient` — typed fetcher used from the UI (`EditableValue`).
 *
 * The schema bounds (`max(64)`) match the practical width of table/field
 * names in this codebase; row IDs are uuids or human ids (<= 64 chars).
 * `corrected_value` is intentionally `z.any()` — the column is jsonb and
 * the source-of-truth shape lives with the consumer, not here.
 */

const IDENT = /^[A-Za-z0-9_-]+$/;

export const OverrideInput = z.object({
  table_name: z.string().min(1).max(64).regex(IDENT, "table_name must be [A-Za-z0-9_-]"),
  row_id: z.string().min(1).max(64),
  field_name: z.string().min(1).max(64).regex(IDENT, "field_name must be [A-Za-z0-9_-]"),
  corrected_value: z.unknown(),
});
export type OverrideInputT = z.infer<typeof OverrideInput>;

export type OverrideResult = { ok: true } | { ok: false; error: string };

export type OverrideClient = {
  set: (input: OverrideInputT) => Promise<OverrideResult>;
};

/**
 * Build a typed client that POSTs to `/api/overrides`. The `fetchImpl` knob
 * exists so tests (and server-side callers) can swap in their own fetcher
 * without polluting the global.
 */
export function makeOverrideClient(fetchImpl: typeof fetch = fetch): OverrideClient {
  return {
    async set(input) {
      let res: Response;
      try {
        res = await fetchImpl("/api/overrides", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "network error";
        return { ok: false, error: msg };
      }
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        return { ok: false, error: text || `HTTP ${res.status}` };
      }
      return { ok: true };
    },
  };
}

/**
 * Default client used by UI components in the browser. Server-side callers
 * should build their own with the appropriate fetch.
 */
export const overrideClient: OverrideClient = makeOverrideClient();
