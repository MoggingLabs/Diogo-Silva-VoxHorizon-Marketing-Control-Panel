import { describe, expect, it } from "vitest";

import { CHILD_REGISTRY, type ChildKey } from "./children";

const KEYS: ChildKey[] = [
  "services",
  "value_props",
  "offers",
  "offer_constraints",
  "assets",
  "past_projects",
];

describe("CHILD_REGISTRY", () => {
  it("has an entry for every child key with a table + schemas", () => {
    for (const key of KEYS) {
      const spec = CHILD_REGISTRY[key];
      expect(spec.table).toMatch(/^client_/);
      expect(spec.resource).toMatch(/^client_/);
      expect(spec.create).toBeDefined();
      expect(spec.update).toBeDefined();
      expect(spec.searchable.length).toBeGreaterThan(0);
      expect(spec.filterable).toContain("sort_order");
    }
  });

  it("maps each key to a distinct table", () => {
    const tables = KEYS.map((k) => CHILD_REGISTRY[k].table);
    expect(new Set(tables).size).toBe(tables.length);
  });

  it("each create schema rejects an empty object", () => {
    for (const key of KEYS) {
      const res = CHILD_REGISTRY[key].create.safeParse({});
      expect(res.success).toBe(false);
    }
  });
});
