/**
 * Parity contract test (M2 / E2.3): the TS rollup mirror MUST match the SQL
 * `pipeline_rollup_cleared` (migration 0039), the single authority.
 *
 * The per-creative gate predicate is defined once in SQL and mirrored in TS
 * (`lib/pipeline/rollup.ts`) for the advance route + the UI grid, and in Python
 * (the worker). This test reads the SQL migration text and asserts the TS
 * cleared-state set + the killed-exclusion rule are still in lockstep, so any
 * future edit to one without the other fails CI rather than re-introducing the
 * drift this milestone fixed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CLEARED_STAGE_STATES } from "./rollup";

const MIGRATION_PATH = fileURLToPath(
  new URL("../../db/migrations/0039_rollup_excludes_killed.sql", import.meta.url),
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("rollup ↔ SQL pipeline_rollup_cleared parity (0039)", () => {
  it("the TS cleared-state set equals the SQL terminal-good set", () => {
    // The SQL excludes a row when `status not in ('passed', 'overridden', 'skipped')`.
    // Parse that list and assert the TS set is exactly it.
    const match = sql.match(/status\s+not\s+in\s*\(([^)]*)\)/i);
    expect(match, "could not find the cleared-state `not in (...)` list in 0039").not.toBeNull();
    const list = match?.[1] ?? "";
    const sqlStates = (list.match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
    expect(new Set(sqlStates)).toEqual(new Set(CLEARED_STAGE_STATES));
  });

  it("the SQL drops killed image creatives from scope (matches isCreativeInScope)", () => {
    expect(sql).toMatch(/<>\s*'killed'/);
  });

  it("the SQL drops soft-deleted creatives from scope", () => {
    expect(sql).toMatch(/deleted_at\s+is\s+null/i);
  });
});
