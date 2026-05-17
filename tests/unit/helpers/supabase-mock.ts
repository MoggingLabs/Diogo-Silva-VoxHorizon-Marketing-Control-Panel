/**
 * Lightweight Supabase client mock for unit tests.
 *
 * Builds a fluent chainable object that supports the patterns used in the
 * codebase:
 *   - `from('table').select(...).eq(...).single()`
 *   - `from('table').select(...).order(...).limit(...).eq(...).lt(...)`
 *   - `from('table').insert(...).select().single()`
 *   - `from('table').insert(...)` (terminal — awaited directly)
 *   - `from('table').update(...).eq(...)`
 *   - `from('table').select(...).in(...)`
 *   - `.channel(...).on(...).subscribe()` / `.removeChannel(...)`
 *
 * Tests configure the responses per table + terminal verb. The builder is
 * intentionally permissive: unconfigured calls return `{ data: null, error:
 * null }` so a test that forgets to specify a path won't blow up on
 * destructuring — it'll just observe empty data.
 *
 * Typical use:
 *
 *   import { mockSupabaseClient } from "@/tests/unit/helpers/supabase-mock";
 *
 *   const supabase = mockSupabaseClient({
 *     pipelines: {
 *       insert: { single: { data: { id: "p1", status: "configuration" }, error: null } },
 *       select: { data: [{ id: "p1" }], error: null },
 *     },
 *     pipeline_events: {
 *       insert: { data: null, error: null },
 *     },
 *   });
 *
 *   const { data, error } = await supabase.from("pipelines").insert({}).select().single();
 */
import { vi } from "vitest";

export type SupabaseMockResult<T = unknown> = {
  data: T | null;
  error: { message: string } | null;
};

/**
 * Per-table behaviour for the mock.
 *
 * - `select` / `update` / `delete` / `insert.data|error` describe the value
 *   returned when the chain is `await`-ed without `.single()`.
 * - `*.single` describes the value returned when the chain ends with
 *   `.single()`. Falls back to the table-level result if omitted.
 */
export type SupabaseTableConfig = {
  select?: SupabaseMockResult & { single?: SupabaseMockResult };
  insert?: SupabaseMockResult & { single?: SupabaseMockResult };
  update?: SupabaseMockResult & { single?: SupabaseMockResult };
  delete?: SupabaseMockResult & { single?: SupabaseMockResult };
};

export type SupabaseMockConfig = Record<string, SupabaseTableConfig>;

const DEFAULT_RESULT: SupabaseMockResult = { data: null, error: null };

type Verb = "select" | "insert" | "update" | "delete";

/**
 * Build a thenable query chain. Every filter method (`eq`, `lt`, ...)
 * returns the same builder, so any number of filters in any order resolve
 * to the configured result. `.single()` returns the configured `*.single`
 * payload if present, falling back to the base result.
 */
function buildChain(verb: Verb, tableConfig: SupabaseTableConfig | undefined) {
  const verbConfig = tableConfig?.[verb];
  const baseResult: SupabaseMockResult = verbConfig
    ? { data: verbConfig.data ?? null, error: verbConfig.error ?? null }
    : DEFAULT_RESULT;
  const singleResult: SupabaseMockResult = verbConfig?.single ?? baseResult;

  // The chain is also "thenable" so `await supabase.from(...).insert(...)`
  // resolves to `baseResult`. We implement `.then` by hand to keep the
  // chainable identity intact for `.select()` / `.eq()` etc.
  const chain: Record<string | symbol, unknown> = {};

  const passthrough = () => chain;

  // Filter / ordering / paging methods all just return the same builder.
  for (const m of [
    "select",
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "is",
    "or",
    "not",
    "match",
    "filter",
    "order",
    "limit",
    "range",
    "contains",
    "containedBy",
    "textSearch",
  ] as const) {
    chain[m] = vi.fn(passthrough);
  }

  chain.single = vi.fn(() => Promise.resolve(singleResult));
  chain.maybeSingle = vi.fn(() => Promise.resolve(singleResult));

  chain.then = (
    onFulfilled?: (v: SupabaseMockResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(baseResult).then(onFulfilled, onRejected);

  return chain;
}

/**
 * Mock realtime channel. `subscribe()` returns the channel itself (matching
 * the real client), and `unsubscribe()` is a no-op spy so cleanup hooks can
 * still verify they ran.
 */
function buildChannel() {
  const channel: Record<string | symbol, unknown> = {};
  channel.on = vi.fn(() => channel);
  channel.subscribe = vi.fn(() => channel);
  channel.unsubscribe = vi.fn(() => Promise.resolve("ok"));
  return channel;
}

/**
 * Build a Vitest-friendly Supabase client mock.
 *
 * The returned object exposes `from`, `channel`, and `removeChannel` plus
 * the `_spies` escape hatch so tests can assert against the underlying
 * `vi.fn`s when they care.
 */
export function mockSupabaseClient(config: SupabaseMockConfig = {}) {
  const fromSpy = vi.fn((table: string) => {
    const tableConfig = config[table];
    const builder: Record<string | symbol, unknown> = {};

    builder.select = vi.fn(() => buildChain("select", tableConfig));
    builder.insert = vi.fn(() => buildChain("insert", tableConfig));
    builder.update = vi.fn(() => buildChain("update", tableConfig));
    builder.delete = vi.fn(() => buildChain("delete", tableConfig));
    builder.upsert = vi.fn(() => buildChain("insert", tableConfig));

    return builder;
  });

  const channelSpy = vi.fn(() => buildChannel());
  const removeChannelSpy = vi.fn(() => Promise.resolve("ok"));

  return {
    from: fromSpy,
    channel: channelSpy,
    removeChannel: removeChannelSpy,
    auth: {
      getUser: vi.fn(() =>
        Promise.resolve({ data: { user: null }, error: null } as SupabaseMockResult),
      ),
      getSession: vi.fn(() =>
        Promise.resolve({ data: { session: null }, error: null } as SupabaseMockResult),
      ),
    },
    _spies: { from: fromSpy, channel: channelSpy, removeChannel: removeChannelSpy },
  };
}

export type SupabaseClientMock = ReturnType<typeof mockSupabaseClient>;
