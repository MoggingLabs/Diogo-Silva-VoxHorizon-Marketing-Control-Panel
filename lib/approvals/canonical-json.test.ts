import { describe, expect, it } from "vitest";

import { canonicalJson, hashToolArgs } from "./canonical-json";

describe("canonicalJson", () => {
  it("sorts object keys alphabetically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`);
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: 0 })).toBe(`{"a":0,"z":{"x":2,"y":1}}`);
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("recurses into nested arrays of objects", () => {
    expect(
      canonicalJson([
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ]),
    ).toBe(`[{"a":2,"b":1},{"c":4,"d":3}]`);
  });

  it("drops undefined properties", () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 2 })).toBe(`{"a":1,"c":2}`);
  });

  it("returns the same string for objects with reordered keys", () => {
    const a = canonicalJson({ alpha: 1, beta: [{ x: 1, y: 2 }] });
    const b = canonicalJson({ beta: [{ y: 2, x: 1 }], alpha: 1 });
    expect(a).toBe(b);
  });

  it("serialises primitives unchanged", () => {
    expect(canonicalJson("hi")).toBe(`"hi"`);
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(null)).toBe("null");
  });

  it("treats class instances as plain objects only when prototype is Object.prototype", () => {
    class Foo {
      a = 1;
      b = 2;
    }
    // Class instances have a non-Object prototype, so canonicaliser leaves
    // them to JSON.stringify which still serialises own enumerable props.
    // We assert the result is deterministic, not that keys get sorted.
    const out = canonicalJson(new Foo());
    expect(out).toContain(`"a":1`);
    expect(out).toContain(`"b":2`);
  });
});

describe("hashToolArgs", () => {
  it("returns 64 hex chars (SHA-256 hex)", () => {
    const h = hashToolArgs({ tool: "x" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same digest regardless of key order", () => {
    const a = hashToolArgs({ a: 1, b: 2 });
    const b = hashToolArgs({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("changes when the value changes", () => {
    const a = hashToolArgs({ a: 1 });
    const b = hashToolArgs({ a: 2 });
    expect(a).not.toBe(b);
  });
});
