"use client";

import * as React from "react";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Inbox,
  Loader2,
  MoreHorizontal,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** A single column definition. Dependency-light (no TanStack Table). */
export type DataTableColumn<T> = {
  /** Stable key; also used as the `?sort=` token when sortable. */
  id: string;
  /** Header label. */
  header: React.ReactNode;
  /** Cell renderer. Receives the whole row. */
  cell: (row: T) => React.ReactNode;
  /** Enable sort affordance on this column. */
  sortable?: boolean;
  /**
   * Accessor used for CLIENT-side sort (ignored in server mode). Falls back
   * to `row[id]` when omitted.
   */
  accessor?: (row: T) => string | number | null | undefined;
  /** Extra className applied to the header + cell. */
  className?: string;
  /** Right-align (e.g. numeric / actions columns). */
  align?: "left" | "right" | "center";
};

/** An enum filter rendered as a Select above the table. */
export type DataTableFilter = {
  id: string;
  label: string;
  options: { value: string; label: string }[];
};

/** A per-row action surfaced in the row "..." menu. */
export type DataTableRowAction<T> = {
  label: string;
  onSelect: (row: T) => void;
  icon?: React.ReactNode;
  destructive?: boolean;
  disabled?: (row: T) => boolean;
};

export type SortDir = "asc" | "desc";

export type DataTableProps<T> = {
  columns: DataTableColumn<T>[];
  data: T[];
  /** Stable row id accessor (required for selection + keys). */
  getRowId: (row: T) => string;

  /** Loading skeleton state. */
  loading?: boolean;
  /** Empty-state message when `data` is empty and not loading. */
  emptyMessage?: React.ReactNode;

  /** Show the text search box. */
  searchable?: boolean;
  searchPlaceholder?: string;

  /** Enum filters rendered above the table. */
  filters?: DataTableFilter[];

  /** Per-row actions ("..." menu). */
  rowActions?: DataTableRowAction<T>[];

  /** Enable bulk row selection (checkbox column + selection callbacks). */
  selectable?: boolean;
  /** Controlled selection (ids). Uncontrolled when omitted. */
  selectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;

  /**
   * Server mode: the parent owns fetching. When true the table does NOT sort/
   * filter/paginate the `data` array; it only reflects URL state and reports
   * changes via `onStateChange`. `pageCount`/`total` describe the server set.
   */
  serverMode?: boolean;
  pageCount?: number;
  total?: number;
  onStateChange?: (state: DataTableState) => void;

  /** Rows per page (client mode pagination + URL default). */
  pageSize?: number;

  /** Optional row click handler (e.g. open detail). */
  onRowClick?: (row: T) => void;

  /**
   * Enable in-table keyboard navigation: ArrowUp/ArrowDown move a focused row,
   * Home/End jump to first/last, Enter or `e` triggers `onEditRow` (falling
   * back to `onRowClick`), Space toggles selection (when `selectable`), and
   * Escape clears focus. Unobtrusive: off unless opted in, and it only acts
   * while focus is inside the table body.
   */
  keyboardNav?: boolean;
  /**
   * Action for the focused row on Enter / `e` (the "edit" affordance). Falls
   * back to `onRowClick` when omitted.
   */
  onEditRow?: (row: T) => void;

  className?: string;
};

export type DataTableState = {
  sort: string | null;
  dir: SortDir;
  q: string;
  page: number;
  filters: Record<string, string>;
};

/** Parse the table state out of a URLSearchParams-like object. */
export function parseTableState(params: URLSearchParams, filterIds: string[] = []): DataTableState {
  const dirRaw = params.get("dir");
  const dir: SortDir = dirRaw === "desc" ? "desc" : "asc";
  const pageRaw = Number(params.get("page") ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const filters: Record<string, string> = {};
  for (const id of filterIds) {
    const v = params.get(`f_${id}`);
    if (v) filters[id] = v;
  }
  return {
    sort: params.get("sort"),
    dir,
    q: params.get("q") ?? "",
    page,
    filters,
  };
}

/**
 * Generic, dependency-light data table.
 *
 * - Column defs with optional client-side sort (accessor) or server sort.
 * - Text search + enum filters.
 * - Pagination (client paginates `data`; server reports `pageCount`).
 * - Bulk row selection (controlled or uncontrolled).
 * - Per-row action menu.
 * - Empty + loading states.
 * - URL-synced state (`?sort=&dir=&q=&page=&f_<id>=`) for deep-linking.
 *
 * In client mode it sorts/filters/paginates the in-memory `data`. In
 * `serverMode` the parent fetches; the table only manages URL state and emits
 * `onStateChange`.
 */
export function DataTable<T>({
  columns,
  data,
  getRowId,
  loading = false,
  emptyMessage = "No records found.",
  searchable = false,
  searchPlaceholder = "Search...",
  filters = [],
  rowActions = [],
  selectable = false,
  selectedIds,
  onSelectionChange,
  serverMode = false,
  pageCount,
  total,
  onStateChange,
  pageSize = 20,
  onRowClick,
  keyboardNav = false,
  onEditRow,
  className,
}: DataTableProps<T>) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filterIds = React.useMemo(() => filters.map((f) => f.id), [filters]);
  const state = React.useMemo(
    () => parseTableState(new URLSearchParams(searchParams?.toString() ?? ""), filterIds),
    [searchParams, filterIds],
  );

  // Local search box mirror so typing feels instant before we push to the URL.
  const [searchDraft, setSearchDraft] = React.useState(state.q);
  React.useEffect(() => setSearchDraft(state.q), [state.q]);

  // Uncontrolled selection fallback.
  const [internalSelection, setInternalSelection] = React.useState<string[]>([]);
  const selection = selectedIds ?? internalSelection;
  const setSelection = React.useCallback(
    (ids: string[]) => {
      if (onSelectionChange) onSelectionChange(ids);
      if (selectedIds === undefined) setInternalSelection(ids);
    },
    [onSelectionChange, selectedIds],
  );

  // Report state to the server-mode parent.
  const lastReported = React.useRef<string>("");
  React.useEffect(() => {
    if (!onStateChange) return;
    const key = JSON.stringify(state);
    if (key === lastReported.current) return;
    lastReported.current = key;
    onStateChange(state);
  }, [state, onStateChange]);

  // ---- URL writers -----------------------------------------------------
  const pushParams = React.useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const p = new URLSearchParams(searchParams?.toString() ?? "");
      mutate(p);
      const qs = p.toString();
      // typedRoutes can't know this runtime-built path; it's same-page URL
      // state (sort/filter/page), so cast through Route.
      router.replace(`${pathname}${qs ? `?${qs}` : ""}` as Route, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const toggleSort = React.useCallback(
    (colId: string) => {
      pushParams((p) => {
        const curSort = p.get("sort");
        const curDir = p.get("dir") === "desc" ? "desc" : "asc";
        if (curSort === colId) {
          p.set("dir", curDir === "asc" ? "desc" : "asc");
        } else {
          p.set("sort", colId);
          p.set("dir", "asc");
        }
        p.delete("page");
      });
    },
    [pushParams],
  );

  const applySearch = React.useCallback(
    (value: string) => {
      pushParams((p) => {
        if (value) p.set("q", value);
        else p.delete("q");
        p.delete("page");
      });
    },
    [pushParams],
  );

  const applyFilter = React.useCallback(
    (id: string, value: string) => {
      pushParams((p) => {
        if (value && value !== "__all__") p.set(`f_${id}`, value);
        else p.delete(`f_${id}`);
        p.delete("page");
      });
    },
    [pushParams],
  );

  const goToPage = React.useCallback(
    (page: number) => {
      pushParams((p) => {
        if (page <= 1) p.delete("page");
        else p.set("page", String(page));
      });
    },
    [pushParams],
  );

  // ---- Client-side data shaping ---------------------------------------
  const columnById = React.useMemo(() => {
    const m = new Map<string, DataTableColumn<T>>();
    for (const c of columns) m.set(c.id, c);
    return m;
  }, [columns]);

  const processed = React.useMemo(() => {
    if (serverMode) return data;
    let rows = data;

    // text search across every column's accessor / raw value
    if (state.q) {
      const needle = state.q.toLowerCase();
      rows = rows.filter((row) =>
        columns.some((c) => {
          const raw = c.accessor ? c.accessor(row) : (row as Record<string, unknown>)[c.id];
          return raw != null && String(raw).toLowerCase().includes(needle);
        }),
      );
    }

    // enum filters: match row[id] === value
    for (const [id, value] of Object.entries(state.filters)) {
      rows = rows.filter((row) => {
        const raw = (row as Record<string, unknown>)[id];
        return raw != null && String(raw) === value;
      });
    }

    // sort
    if (state.sort) {
      const col = columnById.get(state.sort);
      if (col) {
        const acc = col.accessor ?? ((row: T) => (row as Record<string, unknown>)[col.id] as never);
        rows = [...rows].sort((a, b) => {
          const av = acc(a);
          const bv = acc(b);
          if (av == null && bv == null) return 0;
          if (av == null) return -1;
          if (bv == null) return 1;
          if (typeof av === "number" && typeof bv === "number") return av - bv;
          return String(av).localeCompare(String(bv));
        });
        if (state.dir === "desc") rows = rows.reverse();
      }
    }

    return rows;
  }, [serverMode, data, state.q, state.filters, state.sort, state.dir, columns, columnById]);

  const clientTotal = serverMode ? (total ?? data.length) : processed.length;
  const totalPages = serverMode
    ? Math.max(1, pageCount ?? 1)
    : Math.max(1, Math.ceil(processed.length / pageSize));
  const currentPage = Math.min(state.page, totalPages);

  const pageRows = React.useMemo(() => {
    if (serverMode) return processed;
    const start = (currentPage - 1) * pageSize;
    return processed.slice(start, start + pageSize);
  }, [serverMode, processed, currentPage, pageSize]);

  // ---- Selection helpers ----------------------------------------------
  const pageIds = pageRows.map(getRowId);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selection.includes(id));
  const somePageSelected = pageIds.some((id) => selection.includes(id));
  const headerCheckState: boolean | "indeterminate" = allPageSelected
    ? true
    : somePageSelected
      ? "indeterminate"
      : false;

  const toggleAllOnPage = React.useCallback(() => {
    if (allPageSelected) {
      setSelection(selection.filter((id) => !pageIds.includes(id)));
    } else {
      setSelection(Array.from(new Set([...selection, ...pageIds])));
    }
  }, [allPageSelected, selection, pageIds, setSelection]);

  const toggleRow = React.useCallback(
    (id: string) => {
      setSelection(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]);
    },
    [selection, setSelection],
  );

  // ---- Keyboard navigation (opt-in) -----------------------------------
  const [focusedIndex, setFocusedIndex] = React.useState<number | null>(null);
  const rowRefs = React.useRef<(HTMLTableRowElement | null)[]>([]);

  // Keep the focused index in range as the page rows change (filter/sort/page).
  React.useEffect(() => {
    setFocusedIndex((prev) => {
      if (prev === null) return null;
      if (pageRows.length === 0) return null;
      return Math.min(prev, pageRows.length - 1);
    });
  }, [pageRows.length]);

  const focusRowAt = React.useCallback((index: number) => {
    setFocusedIndex(index);
    // Move DOM focus so screen readers + the roving tabindex follow along.
    rowRefs.current[index]?.focus();
  }, []);

  const editRow = React.useCallback(
    (row: T) => {
      if (onEditRow) onEditRow(row);
      else if (onRowClick) onRowClick(row);
    },
    [onEditRow, onRowClick],
  );

  const onBodyKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTableSectionElement>) => {
      if (!keyboardNav || pageRows.length === 0) return;
      const cur = focusedIndex ?? -1;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          // From "no focus" (cur = -1) the first ArrowDown lands on row 0.
          focusRowAt(cur < 0 ? 0 : Math.min(cur + 1, pageRows.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          focusRowAt(cur < 0 ? 0 : Math.max(cur - 1, 0));
          break;
        case "Home":
          e.preventDefault();
          focusRowAt(0);
          break;
        case "End":
          e.preventDefault();
          focusRowAt(pageRows.length - 1);
          break;
        case "Enter":
        case "e":
        case "E": {
          if (cur < 0) return;
          const row = pageRows[cur];
          if (row) {
            e.preventDefault();
            editRow(row);
          }
          break;
        }
        case " ": {
          if (!selectable || cur < 0) return;
          const row = pageRows[cur];
          if (row) {
            e.preventDefault();
            toggleRow(getRowId(row));
          }
          break;
        }
        case "Escape":
          if (focusedIndex !== null) {
            e.preventDefault();
            setFocusedIndex(null);
          }
          break;
      }
    },
    [keyboardNav, pageRows, focusedIndex, focusRowAt, editRow, selectable, toggleRow, getRowId],
  );

  const hasActions = rowActions.length > 0;
  const colSpan = columns.length + (selectable ? 1 : 0) + (hasActions ? 1 : 0);

  const alignClass = (align?: "left" | "right" | "center") =>
    align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Toolbar */}
      {(searchable || filters.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {searchable && (
            <div className="relative max-w-xs flex-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applySearch(searchDraft);
                }}
                onBlur={() => {
                  if (searchDraft !== state.q) applySearch(searchDraft);
                }}
                placeholder={searchPlaceholder}
                aria-label="Search table"
                className="h-9 pl-8"
              />
            </div>
          )}
          {filters.map((f) => (
            <Select
              key={f.id}
              value={state.filters[f.id] ?? "__all__"}
              onValueChange={(v) => applyFilter(f.id, v)}
            >
              <SelectTrigger className="h-9 w-auto min-w-[8rem]" aria-label={f.label}>
                <SelectValue placeholder={f.label} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All {f.label}</SelectItem>
                {f.options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {selectable && (
                <TableHead className="w-10">
                  <Checkbox
                    checked={headerCheckState}
                    onCheckedChange={toggleAllOnPage}
                    aria-label="Select all rows on this page"
                    disabled={pageIds.length === 0}
                  />
                </TableHead>
              )}
              {columns.map((col) => (
                <TableHead key={col.id} className={cn(alignClass(col.align), col.className)}>
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.id)}
                      className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Sort by ${typeof col.header === "string" ? col.header : col.id}`}
                    >
                      <span>{col.header}</span>
                      {state.sort === col.id ? (
                        state.dir === "asc" ? (
                          <ArrowUp className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden="true" />
                        )
                      ) : (
                        <ChevronsUpDown className="h-3 w-3 opacity-40" aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </TableHead>
              ))}
              {hasActions && <TableHead className="sr-only w-10 text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody onKeyDown={keyboardNav ? onBodyKeyDown : undefined}>
            {loading ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={colSpan} className="h-32">
                  <div
                    className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
                    role="status"
                  >
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    <span>Loading...</span>
                  </div>
                </TableCell>
              </TableRow>
            ) : pageRows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={colSpan} className="h-32">
                  <div className="flex flex-col items-center justify-center gap-2 py-6 text-center text-sm text-muted-foreground">
                    <Inbox className="h-6 w-6 opacity-50" aria-hidden="true" />
                    <span>{emptyMessage}</span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((row, rowIndex) => {
                const id = getRowId(row);
                const isSelected = selection.includes(id);
                const isFocused = keyboardNav && focusedIndex === rowIndex;
                return (
                  <TableRow
                    key={id}
                    ref={
                      keyboardNav
                        ? (el) => {
                            rowRefs.current[rowIndex] = el;
                          }
                        : undefined
                    }
                    data-state={isSelected ? "selected" : undefined}
                    data-focused={isFocused ? "true" : undefined}
                    tabIndex={
                      keyboardNav
                        ? isFocused || (focusedIndex === null && rowIndex === 0)
                          ? 0
                          : -1
                        : undefined
                    }
                    className={cn(
                      onRowClick && "cursor-pointer",
                      isFocused && "bg-accent/15 outline outline-2 -outline-offset-2 outline-ring",
                    )}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onFocus={keyboardNav ? () => setFocusedIndex(rowIndex) : undefined}
                  >
                    {selectable && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleRow(id)}
                          aria-label={`Select row ${id}`}
                        />
                      </TableCell>
                    )}
                    {columns.map((col) => (
                      <TableCell key={col.id} className={cn(alignClass(col.align), col.className)}>
                        {col.cell(row)}
                      </TableCell>
                    ))}
                    {hasActions && (
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              aria-label="Row actions"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {rowActions.map((action) => (
                              <DropdownMenuItem
                                key={action.label}
                                disabled={action.disabled?.(row)}
                                onSelect={() => action.onSelect(row)}
                                className={cn(
                                  action.destructive && "text-destructive focus:text-destructive",
                                )}
                              >
                                {action.icon}
                                <span>{action.label}</span>
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Footer: count + pagination */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <div>
          {selectable && selection.length > 0 ? (
            <span>{selection.length} selected</span>
          ) : (
            <span>
              {clientTotal} {clientTotal === 1 ? "record" : "records"}
            </span>
          )}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">Prev</span>
            </Button>
            <span aria-live="polite">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= totalPages}
              aria-label="Next page"
            >
              <span className="sr-only sm:not-sr-only">Next</span>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
