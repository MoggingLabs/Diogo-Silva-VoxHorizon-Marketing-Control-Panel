/**
 * Unit tests for the CRUD list-query parser + applier (E1.1 / #583).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  applyListQuery,
  paginationMeta,
  parseListQuery,
  type FilterableQuery,
  type ListQuery,
} from "./list-query";

function sp(qs: string): URLSearchParams {
  return new URLSearchParams(qs);
}

describe("parseListQuery", () => {
  it("defaults: empty params -> page 1, default size, default sort/dir", () => {
    const q = parseListQuery(sp(""), { defaultSort: "created_at", defaultPageSize: 25 });
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(25);
    expect(q.sort).toBe("created_at");
    expect(q.dir).toBe("desc");
    expect(q.filters).toEqual([]);
    expect(q.q).toBeNull();
    expect(q.rangeFrom).toBe(0);
    expect(q.rangeTo).toBe(24);
  });

  it("parses an allow-listed single-value filter as eq-shaped (one value)", () => {
    const q = parseListQuery(sp("status=active"), { filterable: ["status"] });
    expect(q.filters).toEqual([{ column: "status", values: ["active"] }]);
  });

  it("parses a repeated allow-listed filter as multi-value (in-shaped)", () => {
    const q = parseListQuery(sp("status=active&status=paused"), { filterable: ["status"] });
    expect(q.filters).toEqual([{ column: "status", values: ["active", "paused"] }]);
  });

  it("ignores filters not in the allow-list", () => {
    const q = parseListQuery(sp("status=active&secret=1"), { filterable: ["status"] });
    expect(q.filters).toEqual([{ column: "status", values: ["active"] }]);
  });

  it("ignores empty filter values", () => {
    const q = parseListQuery(sp("status="), { filterable: ["status"] });
    expect(q.filters).toEqual([]);
  });

  it("trims free-text q and nulls a blank one", () => {
    expect(parseListQuery(sp("q=%20%20")).q).toBeNull();
    expect(parseListQuery(sp("q=roof")).q).toBe("roof");
    expect(parseListQuery(sp("q=%20roof%20")).q).toBe("roof");
  });

  it("honours sort only for allow-listed columns; falls back to default otherwise", () => {
    const filterable = ["name", "created_at"];
    expect(parseListQuery(sp("sort=name"), { filterable }).sort).toBe("name");
    expect(parseListQuery(sp("sort=evil"), { filterable, defaultSort: "created_at" }).sort).toBe(
      "created_at",
    );
    expect(parseListQuery(sp(""), { filterable }).sort).toBeNull();
  });

  it("parses dir asc/desc and rejects junk -> default", () => {
    const filterable = ["name"];
    expect(parseListQuery(sp("sort=name&dir=asc"), { filterable }).dir).toBe("asc");
    expect(parseListQuery(sp("sort=name&dir=desc"), { filterable }).dir).toBe("desc");
    expect(parseListQuery(sp("sort=name&dir=sideways"), { filterable }).dir).toBe("desc");
    expect(
      parseListQuery(sp("sort=name&dir=sideways"), { filterable, defaultDir: "asc" }).dir,
    ).toBe("asc");
  });

  it("clamps pageSize to [1, maxPageSize] and floors page at 1", () => {
    expect(parseListQuery(sp("pageSize=9999"), { maxPageSize: 100 }).pageSize).toBe(100);
    expect(parseListQuery(sp("pageSize=0"), { maxPageSize: 100 }).pageSize).toBe(1);
    expect(parseListQuery(sp("pageSize=-5"), { maxPageSize: 100 }).pageSize).toBe(1);
    expect(parseListQuery(sp("page=0")).page).toBe(1);
    expect(parseListQuery(sp("page=-3")).page).toBe(1);
  });

  it("falls back to defaults on non-numeric page/pageSize", () => {
    const q = parseListQuery(sp("page=abc&pageSize=xyz"), { defaultPageSize: 25 });
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(25);
  });

  it("derives the range window from page + pageSize", () => {
    const q = parseListQuery(sp("page=3&pageSize=10"));
    expect(q.rangeFrom).toBe(20);
    expect(q.rangeTo).toBe(29);
  });
});

/** A fake PostgREST builder that records every call for assertions. */
type Call = [string, unknown[]];
interface FakeQuery extends FilterableQuery<FakeQuery> {
  calls: Call[];
}

function fakeQuery(): FakeQuery {
  const calls: Call[] = [];
  const self = { calls } as FakeQuery;
  const rec =
    (name: string) =>
    (...a: unknown[]): FakeQuery => {
      calls.push([name, a]);
      return self;
    };
  self.eq = vi.fn(rec("eq"));
  self.in = vi.fn(rec("in"));
  self.is = vi.fn(rec("is"));
  self.or = vi.fn(rec("or"));
  self.order = vi.fn(rec("order"));
  self.range = vi.fn(rec("range"));
  return self;
}

describe("applyListQuery", () => {
  const base: ListQuery = {
    filters: [],
    q: null,
    sort: null,
    dir: "desc",
    page: 1,
    pageSize: 25,
    rangeFrom: 0,
    rangeTo: 24,
  };

  it("excludes soft-deleted rows by default and ranges", () => {
    const q = fakeQuery();
    applyListQuery(q, base);
    expect(q.calls).toContainEqual(["is", ["deleted_at", null]]);
    expect(q.calls).toContainEqual(["range", [0, 24]]);
  });

  it("can keep soft-deleted rows and use a custom tombstone column", () => {
    const q = fakeQuery();
    applyListQuery(q, base, { excludeDeleted: false });
    expect(q.calls.find((c) => c[0] === "is")).toBeUndefined();

    const q2 = fakeQuery();
    applyListQuery(q2, base, { deletedColumn: "archived_at" });
    expect(q2.calls).toContainEqual(["is", ["archived_at", null]]);
  });

  it("applies a single-value filter as eq", () => {
    const q = fakeQuery();
    applyListQuery(q, { ...base, filters: [{ column: "status", values: ["active"] }] });
    expect(q.calls).toContainEqual(["eq", ["status", "active"]]);
  });

  it("applies a multi-value filter as in", () => {
    const q = fakeQuery();
    applyListQuery(q, { ...base, filters: [{ column: "status", values: ["a", "b"] }] });
    expect(q.calls).toContainEqual(["in", ["status", ["a", "b"]]]);
  });

  it("applies free-text as an ilike OR group over searchable columns", () => {
    const q = fakeQuery();
    applyListQuery(q, { ...base, q: "roof" }, { searchable: ["name", "slug"] });
    expect(q.calls).toContainEqual(["or", ["name.ilike.%roof%,slug.ilike.%roof%"]]);
  });

  it("escapes commas/parens in the free-text term", () => {
    const q = fakeQuery();
    applyListQuery(q, { ...base, q: "a,b(c)" }, { searchable: ["name"] });
    expect(q.calls).toContainEqual(["or", ["name.ilike.%a\\,b\\(c\\)%"]]);
  });

  it("ignores free-text when no searchable columns are configured", () => {
    const q = fakeQuery();
    applyListQuery(q, { ...base, q: "roof" });
    expect(q.calls.find((c) => c[0] === "or")).toBeUndefined();
  });

  it("applies ordering when sort is set (asc + desc)", () => {
    const asc = fakeQuery();
    applyListQuery(asc, { ...base, sort: "name", dir: "asc" });
    expect(asc.calls).toContainEqual(["order", ["name", { ascending: true }]]);

    const desc = fakeQuery();
    applyListQuery(desc, { ...base, sort: "name", dir: "desc" });
    expect(desc.calls).toContainEqual(["order", ["name", { ascending: false }]]);
  });

  it("does not order when sort is null", () => {
    const q = fakeQuery();
    applyListQuery(q, base);
    expect(q.calls.find((c) => c[0] === "order")).toBeUndefined();
  });
});

describe("paginationMeta", () => {
  const q: ListQuery = {
    filters: [],
    q: null,
    sort: null,
    dir: "desc",
    page: 2,
    pageSize: 10,
    rangeFrom: 10,
    rangeTo: 19,
  };

  it("computes pageCount from an exact total", () => {
    expect(paginationMeta(q, 35)).toEqual({ page: 2, pageSize: 10, total: 35, pageCount: 4 });
  });

  it("returns at least 1 page even for 0 rows", () => {
    expect(paginationMeta(q, 0).pageCount).toBe(1);
  });

  it("passes through a null total (no count requested)", () => {
    expect(paginationMeta(q, null)).toEqual({
      page: 2,
      pageSize: 10,
      total: null,
      pageCount: null,
    });
  });
});
