/**
 * Small DSL helper that builds `SupabaseTableConfig` entries without forcing
 * callers to repeat `data: null, error: null` at every verb when they only
 * care about `.single()` results.
 *
 * The shared mock at `tests/unit/helpers/supabase-mock.ts` types the verb
 * shape as `SupabaseMockResult & { single?: SupabaseMockResult }`. The
 * intersection makes `data` and `error` *required* at the verb level even
 * when a caller only configures `single`. `mockClient` here is a thin
 * wrapper over `mockSupabaseClient` that supplies the missing defaults so
 * test files stay terse while keeping the helper signature untouched.
 *
 * `withRpc` is a separate convenience for the routes that go through
 * `supabase.rpc(...)`; the shared mock doesn't model that surface and we
 * monkey-patch the returned client per test.
 */
import { vi } from "vitest";

import {
  mockSupabaseClient,
  type SupabaseClientMock,
  type SupabaseMockConfig,
  type SupabaseMockResult,
  type SupabaseTableConfig,
} from "@/tests/unit/helpers/supabase-mock";

type LooseVerb = Partial<SupabaseMockResult> & {
  single?: SupabaseMockResult;
};

type LooseTableConfig = {
  select?: LooseVerb;
  insert?: LooseVerb;
  update?: LooseVerb;
  delete?: LooseVerb;
};

const DEFAULTS: SupabaseMockResult = { data: null, error: null };

function fillVerb(
  verb: LooseVerb | undefined,
): (SupabaseMockResult & { single?: SupabaseMockResult }) | undefined {
  if (!verb) return undefined;
  return {
    data: verb.data ?? DEFAULTS.data,
    error: verb.error ?? DEFAULTS.error,
    ...(verb.single ? { single: verb.single } : {}),
  };
}

function fillTable(table: LooseTableConfig): SupabaseTableConfig {
  const out: SupabaseTableConfig = {};
  const select = fillVerb(table.select);
  if (select) out.select = select;
  const insert = fillVerb(table.insert);
  if (insert) out.insert = insert;
  const update = fillVerb(table.update);
  if (update) out.update = update;
  const del = fillVerb(table.delete);
  if (del) out.delete = del;
  return out;
}

/**
 * Wrapper around `mockSupabaseClient` that accepts a relaxed config where
 * `data` and `error` at the verb level default to `null` when omitted.
 *
 * Silent-failure PR-4: an optional `rpc` key plumbs through to the mock's
 * RPC resolver (routes call `compute_pipeline_status(id)` after the
 * `pipelines.status` column was dropped). Pass
 * `{ rpc: { compute_pipeline_status: { data: "ideation", error: null } } }`
 * to seed the derived status for a test.
 */
export function mockClient(
  config: Record<string, LooseTableConfig> & {
    rpc?: Record<string, SupabaseMockResult>;
  } = {},
  options: { storageSign?: (path: string) => string | null } = {},
): SupabaseClientMock {
  const filled: SupabaseMockConfig = {};
  for (const [table, t] of Object.entries(config)) {
    if (table === "rpc") continue;
    filled[table] = fillTable(t as LooseTableConfig);
  }
  if (config.rpc) filled.rpc = config.rpc;
  return mockSupabaseClient(filled, options);
}

/**
 * Add an `rpc` spy to the mock client returning the supplied result.
 * The factory variant accepts the RPC name so different RPCs in the same
 * test can return different payloads.
 *
 * Silent-failure PR-4: the helper preserves the previously-installed
 * `rpc` spy's behaviour for `compute_pipeline_status` (the reducer call
 * routes use to derive the dropped `pipelines.status` column). When the
 * caller supplies a single result / factory that doesn't differentiate by
 * RPC name, we fall back to the prior spy for `compute_pipeline_status` so
 * existing tests that called `withRpc(...)` for a different RPC (e.g.
 * `gen_brief_id_human`) keep working without per-test edits.
 */
export function withRpc(
  client: SupabaseClientMock,
  resultOrFactory:
    | { data: unknown; error: { message: string } | null }
    | ((name: string) => { data: unknown; error: { message: string } | null }),
): SupabaseClientMock {
  const previousRpc = (client as unknown as { rpc?: (...args: unknown[]) => Promise<unknown> }).rpc;
  (client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc = vi.fn(
    (name: string, args?: unknown) => {
      // Preserve the prior derived-status path when the caller hasn't
      // explicitly overridden it via a name-aware factory.
      if (name === "compute_pipeline_status" && previousRpc) {
        return previousRpc(name, args) as Promise<{
          data: unknown;
          error: { message: string } | null;
        }>;
      }
      return Promise.resolve(
        typeof resultOrFactory === "function" ? resultOrFactory(name) : resultOrFactory,
      );
    },
  );
  return client;
}
