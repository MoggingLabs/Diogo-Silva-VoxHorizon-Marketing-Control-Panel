import { describe, expect, it } from "vitest";

import {
  SUBSCRIBABLE_TABLES,
  encodeSubs,
  isValidSpec,
  parseSubs,
  type RealtimeSubscriptionSpec,
} from "./topics";

describe("topics — SUBSCRIBABLE_TABLES", () => {
  it("includes the publication tables + the filtered-only `events` table", () => {
    for (const t of [
      "briefs",
      "creatives",
      "pipeline_events",
      "approvals",
      "approval_mode",
      "events",
    ]) {
      expect(SUBSCRIBABLE_TABLES.has(t)).toBe(true);
    }
  });

  it("excludes tables that are never subscribed (sync_log)", () => {
    expect(SUBSCRIBABLE_TABLES.has("sync_log")).toBe(false);
  });
});

describe("isValidSpec", () => {
  it("accepts a well-formed spec on an allowlisted table", () => {
    expect(isValidSpec({ table: "creatives", event: "INSERT" })).toBe(true);
    expect(isValidSpec({ table: "pipeline_events", event: "*", filter: "pipeline_id=eq.x" })).toBe(
      true,
    );
  });

  it("rejects non-objects", () => {
    expect(isValidSpec(null)).toBe(false);
    expect(isValidSpec("x")).toBe(false);
    expect(isValidSpec(42)).toBe(false);
  });

  it("rejects a table not on the allowlist", () => {
    expect(isValidSpec({ table: "secret_table", event: "INSERT" })).toBe(false);
  });

  it("rejects an unknown event", () => {
    expect(isValidSpec({ table: "creatives", event: "TRUNCATE" })).toBe(false);
  });

  it("rejects a non-string filter", () => {
    expect(isValidSpec({ table: "creatives", event: "INSERT", filter: 5 })).toBe(false);
  });

  it("accepts an omitted filter", () => {
    expect(isValidSpec({ table: "creatives", event: "DELETE" })).toBe(true);
  });
});

describe("encodeSubs / parseSubs round-trip", () => {
  it("round-trips a spec list, preserving filters with special chars", () => {
    const specs: RealtimeSubscriptionSpec[] = [
      { table: "pipeline_events", event: "INSERT", filter: "pipeline_id=eq.abc-123" },
      { table: "pipelines", event: "*" },
    ];
    const encoded = encodeSubs(specs);
    // URL-safe: no +, /, or = padding.
    expect(encoded).not.toMatch(/[+/=]/);
    expect(parseSubs(encoded)).toEqual(specs);
  });

  it("parseSubs returns [] for null / empty", () => {
    expect(parseSubs(null)).toEqual([]);
    expect(parseSubs("")).toEqual([]);
  });

  it("parseSubs returns [] for malformed base64", () => {
    expect(parseSubs("!!!not base64!!!")).toEqual([]);
  });

  it("parseSubs returns [] when the decoded JSON is not an array", () => {
    const encoded = encodeSubs([] as RealtimeSubscriptionSpec[]);
    expect(parseSubs(encoded)).toEqual([]);
    // Encode a non-array object manually.
    const objJson = btoa(JSON.stringify({ not: "an array" }));
    expect(parseSubs(objJson)).toEqual([]);
  });

  it("parseSubs filters out invalid specs but keeps valid ones", () => {
    const mixed = btoa(
      JSON.stringify([
        { table: "creatives", event: "INSERT" },
        { table: "evil", event: "INSERT" },
        { table: "briefs", event: "BOGUS" },
      ]),
    );
    expect(parseSubs(mixed)).toEqual([{ table: "creatives", event: "INSERT" }]);
  });
});
