import "server-only";

/**
 * Reusable CRUD backend helpers (E1.1 / #583).
 *
 * Server-only, framework-light building blocks every safe CRUD resource route
 * (M2+) composes:
 *   - list-query parsing + application (filter / sort / paginate / free-text)
 *   - soft-delete + restore (compare-and-set) + hard-delete for child rows
 *   - non-fatal audit-event emit
 *   - consistent JSON response + error helpers (400 / 404 / 409 / 500)
 *
 * Import from `@/lib/crud` rather than the individual files so the surface is
 * one stable module per the plan's "Shared helpers `lib/crud/*`".
 */

export {
  parseListQuery,
  applyListQuery,
  paginationMeta,
  type ListQuery,
  type ColumnFilter,
  type SortDir,
  type ParseListQueryOptions,
  type ApplyListQueryOptions,
  type FilterableQuery,
} from "./list-query";

export {
  softDelete,
  restore,
  hardDelete,
  type MutationResult,
  type SoftDeleteOptions,
} from "./soft-delete";

export { emitEvent, emitEvents, eventKind, type EmitEventInput, type EventInsert } from "./events";

export {
  ok,
  created,
  zodError,
  badJson,
  badRequest,
  notFound,
  conflict,
  serverError,
} from "./responses";
