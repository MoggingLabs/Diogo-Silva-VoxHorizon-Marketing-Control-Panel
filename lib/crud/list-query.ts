import "server-only";

/**
 * List-query parsing for the reusable CRUD stack (E1.1 / #583).
 *
 * Turns a list endpoint's `URLSearchParams` into a typed, validated query
 * descriptor that resource routes (M2+) feed to `applyListQuery` against a
 * Supabase/PostgREST query builder. It standardises the four list controls the
 * `DataTable` (M0) emits as URL state:
 *
 *   - filter by allow-listed columns  (`?<col>=<value>`, repeatable -> `in`)
 *   - sort                            (`?sort=<col>&dir=asc|desc`)
 *   - paginate                        (`?page=<n>&pageSize=<n>`)  [1-based page]
 *   - free-text search                (`?q=<text>` over allow-listed columns)
 *
 * Security: only columns the caller explicitly allow-lists can be filtered,
 * sorted, or searched. Anything else in the query string is ignored, so an
 * untrusted client can never sort/filter by an arbitrary (or non-existent)
 * column and leak a 500 or an index-scan footgun.
 */

/** Sort direction. */
export type SortDir = "asc" | "desc";

/** A single equality/`in` filter resolved from the query string. */
export type ColumnFilter = {
  column: string;
  /** One value -> `eq`; multiple (repeated param) -> `in`. */
  values: string[];
};

/** The parsed, validated descriptor a resource route acts on. */
export type ListQuery = {
  /** Column filters, in declaration order of `filterable`. */
  filters: ColumnFilter[];
  /** Free-text query (trimmed, non-empty) or null. */
  q: string | null;
  /** Sort column (always an allow-listed column) or null for the default. */
  sort: string | null;
  /** Sort direction; defaults to `desc`. */
  dir: SortDir;
  /** 1-based page number (>= 1). */
  page: number;
  /** Page size (clamped to [1, maxPageSize]). */
  pageSize: number;
  /** Inclusive `range()` start index (0-based), derived from page/pageSize. */
  rangeFrom: number;
  /** Inclusive `range()` end index, derived from page/pageSize. */
  rangeTo: number;
};

export type ParseListQueryOptions = {
  /**
   * Columns a client may filter (`?<col>=`) or sort (`?sort=<col>`) by.
   * Anything outside this set is ignored.
   */
  filterable?: readonly string[];
  /**
   * Columns the free-text `?q=` searches (case-insensitive, substring). When
   * empty, `?q=` is ignored.
   */
  searchable?: readonly string[];
  /** Default sort column when `?sort=` is absent or not allow-listed. */
  defaultSort?: string | null;
  /** Default sort direction. Defaults to `desc`. */
  defaultDir?: SortDir;
  /** Default page size when `?pageSize=` is absent. Defaults to 25. */
  defaultPageSize?: number;
  /** Hard ceiling on page size (a client cannot exceed it). Defaults to 100. */
  maxPageSize?: number;
};

function toInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse `URLSearchParams` into a `ListQuery`. Reserved control params
 * (`sort`, `dir`, `page`, `pageSize`, `q`) are never treated as column filters,
 * so a column literally named one of those would need a dedicated route.
 */
export function parseListQuery(
  params: URLSearchParams,
  options: ParseListQueryOptions = {},
): ListQuery {
  const {
    filterable = [],
    searchable = [],
    defaultSort = null,
    defaultDir = "desc",
    defaultPageSize = 25,
    maxPageSize = 100,
  } = options;

  // --- filters: one ColumnFilter per allow-listed column that appears ------
  const filters: ColumnFilter[] = [];
  for (const column of filterable) {
    const values = params.getAll(column).filter((v) => v.length > 0);
    if (values.length > 0) filters.push({ column, values });
  }

  // --- free-text -----------------------------------------------------------
  const rawQ = params.get("q");
  const q = rawQ && rawQ.trim().length > 0 ? rawQ.trim() : null;

  // --- sort: only honour an allow-listed column ----------------------------
  const requestedSort = params.get("sort");
  const sort = requestedSort && filterable.includes(requestedSort) ? requestedSort : defaultSort;
  const requestedDir = params.get("dir");
  const dir: SortDir =
    requestedDir === "asc" || requestedDir === "desc" ? requestedDir : defaultDir;

  // --- pagination (1-based page) -------------------------------------------
  const page = Math.max(1, toInt(params.get("page"), 1));
  const rawPageSize = toInt(params.get("pageSize"), defaultPageSize);
  const pageSize = Math.min(maxPageSize, Math.max(1, rawPageSize));
  const rangeFrom = (page - 1) * pageSize;
  const rangeTo = rangeFrom + pageSize - 1;

  // searchable is captured into the descriptor via the closure in
  // applyListQuery; expose nothing extra here (kept on the options object).
  void searchable;

  return { filters, q, sort, dir, page, pageSize, rangeFrom, rangeTo };
}

/**
 * The minimal subset of the PostgREST query builder `applyListQuery` touches.
 * Each method returns the same builder type so calls chain. Declaring it
 * locally (rather than importing the Supabase generics) keeps the helper
 * framework-light and trivially mockable in unit tests.
 */
export type FilterableQuery<Q> = {
  eq(column: string, value: unknown): Q;
  in(column: string, values: readonly unknown[]): Q;
  is(column: string, value: null | boolean): Q;
  or(filter: string): Q;
  order(column: string, opts: { ascending: boolean }): Q;
  range(from: number, to: number): Q;
};

export type ApplyListQueryOptions = {
  /** Columns the `q` free-text searches with `ilike`. */
  searchable?: readonly string[];
  /**
   * When true, append `deleted_at is null` so soft-deleted rows are excluded.
   * Defaults to true (the common case for a list view).
   */
  excludeDeleted?: boolean;
  /** Column holding the soft-delete tombstone. Defaults to `deleted_at`. */
  deletedColumn?: string;
};

/** Escape a value for a PostgREST `or(...)` `ilike` term (commas / parens). */
function escapeOrValue(value: string): string {
  return value.replace(/([(),])/g, "\\$1");
}

/**
 * Apply a parsed `ListQuery` to a PostgREST query builder: equality / `in`
 * filters, the free-text `ilike` OR-group, the soft-delete exclusion, ordering,
 * and the `range()` window. The builder is returned so the caller can `await`
 * it (optionally after `.select("*", { count: "exact" })`).
 */
export function applyListQuery<Q extends FilterableQuery<Q>>(
  query: Q,
  list: ListQuery,
  options: ApplyListQueryOptions = {},
): Q {
  const { searchable = [], excludeDeleted = true, deletedColumn = "deleted_at" } = options;

  let q = query;

  if (excludeDeleted) {
    q = q.is(deletedColumn, null);
  }

  for (const filter of list.filters) {
    if (filter.values.length === 1) {
      q = q.eq(filter.column, filter.values[0]);
    } else {
      q = q.in(filter.column, filter.values);
    }
  }

  if (list.q && searchable.length > 0) {
    const term = `%${escapeOrValue(list.q)}%`;
    const orFilter = searchable.map((col) => `${col}.ilike.${term}`).join(",");
    q = q.or(orFilter);
  }

  if (list.sort) {
    q = q.order(list.sort, { ascending: list.dir === "asc" });
  }

  q = q.range(list.rangeFrom, list.rangeTo);

  return q;
}

/**
 * Build the standard list-response pagination envelope from a row count.
 * `total` is the exact count when the route requested `{ count: "exact" }`,
 * else null (page-only mode).
 */
export function paginationMeta(
  list: ListQuery,
  total: number | null,
): { page: number; pageSize: number; total: number | null; pageCount: number | null } {
  const pageCount = total === null ? null : Math.max(1, Math.ceil(total / list.pageSize));
  return { page: list.page, pageSize: list.pageSize, total, pageCount };
}
