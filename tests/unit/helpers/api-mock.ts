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
 */
export function mockClient(config: Record<string, LooseTableConfig> = {}): SupabaseClientMock {
  const filled: SupabaseMockConfig = {};
  for (const [table, t] of Object.entries(config)) {
    filled[table] = fillTable(t);
  }
  return mockSupabaseClient(filled);
}

/**
 * Add an `rpc` spy to the mock client returning the supplied result.
 * The factory variant accepts the RPC name so different RPCs in the same
 * test can return different payloads.
 */
export function withRpc(
  client: SupabaseClientMock,
  resultOrFactory:
    | { data: unknown; error: { message: string } | null }
    | ((name: string) => { data: unknown; error: { message: string } | null }),
): SupabaseClientMock {
  (client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc = vi.fn((name: string) =>
    Promise.resolve(
      typeof resultOrFactory === "function" ? resultOrFactory(name) : resultOrFactory,
    ),
  );
  return client;
}
