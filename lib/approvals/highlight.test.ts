import { describe, expect, it } from "vitest";

import { classifyValue, summariseArgs, walk } from "./highlight";

describe("classifyValue", () => {
  it("flags path values starting with /", () => {
    expect(classifyValue("input", "/etc/hosts")).toBe("path");
  });
  it("flags ~ paths", () => {
    expect(classifyValue("input", "~/Documents")).toBe("path");
  });
  it("flags Windows-style paths", () => {
    expect(classifyValue("input", "C:\\Users\\me")).toBe("path");
    expect(classifyValue("input", "D:/data")).toBe("path");
  });
  it("flags http/https URLs", () => {
    expect(classifyValue("input", "https://example.com")).toBe("url");
    expect(classifyValue("input", "http://example.com")).toBe("url");
  });
  it("flags money values via $-prefixed strings over 50", () => {
    expect(classifyValue("note", "$120.50")).toBe("money");
    expect(classifyValue("note", "$ 75")).toBe("money");
  });
  it("does NOT flag $-prefixed values <= 50", () => {
    expect(classifyValue("note", "$10")).toBe("plain");
    expect(classifyValue("note", "$50")).toBe("plain");
  });
  it("flags money via cost/price/amount/spend key + numeric > 50", () => {
    expect(classifyValue("cost", 60)).toBe("money");
    expect(classifyValue("price", 9999)).toBe("money");
    expect(classifyValue("amount", 51)).toBe("money");
    expect(classifyValue("daily_spend", 75)).toBe("money");
  });
  it("does NOT flag money key with numeric <= 50", () => {
    expect(classifyValue("cost", 40)).toBe("plain");
    expect(classifyValue("cost", 50)).toBe("plain");
  });
  it("returns plain for unknown shapes", () => {
    expect(classifyValue("misc", "hello")).toBe("plain");
    expect(classifyValue("count", 99)).toBe("plain");
    expect(classifyValue(null, true)).toBe("plain");
    expect(classifyValue(null, null)).toBe("plain");
  });
});

describe("walk", () => {
  it("returns a flat list for a flat object", () => {
    const leaves = walk({ name: "x", path: "/etc" });
    expect(leaves.map((l) => l.path).sort()).toEqual(["name", "path"]);
    const path = leaves.find((l) => l.path === "path")!;
    expect(path.kind).toBe("path");
  });

  it("descends into nested objects", () => {
    const leaves = walk({ inner: { url: "https://x.dev", n: 1 } });
    const url = leaves.find((l) => l.path === "inner.url")!;
    expect(url.kind).toBe("url");
    const n = leaves.find((l) => l.path === "inner.n")!;
    expect(n.kind).toBe("plain");
  });

  it("uses bracket notation for array indices", () => {
    const leaves = walk({ list: ["a", "b"] });
    expect(leaves.map((l) => l.path).sort()).toEqual(["list[0]", "list[1]"]);
  });

  it("handles top-level primitives", () => {
    const leaves = walk("hi");
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.path).toBe("(root)");
    expect(leaves[0]!.value).toBe("hi");
  });

  it("stringifies numbers/booleans/null via JSON.stringify", () => {
    expect(walk(42)[0]!.value).toBe("42");
    expect(walk(true)[0]!.value).toBe("true");
    expect(walk(null)[0]!.value).toBe("null");
  });

  it("represents undefined leaves as 'undefined'", () => {
    expect(walk(undefined)[0]!.value).toBe("undefined");
  });

  it("classifies money inside nested objects via the leaf key", () => {
    const leaves = walk({ params: { cost: 100, name: "ok" } });
    const cost = leaves.find((l) => l.path === "params.cost")!;
    expect(cost.kind).toBe("money");
  });
});

describe("summariseArgs", () => {
  it("returns zeros for null / undefined input", () => {
    const s = summariseArgs(undefined);
    expect(s.totalLeaves).toBe(0);
    expect(s.kinds.money).toBe(0);
  });

  it("counts each leaf by kind", () => {
    const s = summariseArgs({
      cost: 100, // money
      path: "/etc/passwd", // path
      url: "https://x", // url
      misc: "ok", // plain
      n: 1, // plain
    });
    expect(s.totalLeaves).toBe(5);
    expect(s.kinds).toEqual({ money: 1, path: 1, url: 1, plain: 2 });
  });
});
