/**
 * Unit tests for the CRUD audit-event emit helper (E1.1 / #583).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import type { SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

import { emitEvent, emitEvents, eventKind } from "./events";

type Admin = Parameters<typeof emitEvent>[0];

/**
 * The mock's `from()` returns a fresh builder per call, so the `insert` spy
 * lives on the builder instance the helper used. Pull the most recent builder
 * out of the `from` spy's results to assert against its `insert`.
 */
function lastInsertArgs(supabase: SupabaseClientMock): unknown {
  const results = supabase._spies.from.mock.results;
  const last = results[results.length - 1];
  const builder = last?.value as { insert: ReturnType<typeof vi.fn> } | undefined;
  return builder?.insert.mock.calls[0]?.[0];
}

describe("crud/events", () => {
  let supabase: SupabaseClientMock;

  beforeEach(() => {
    supabase = mockClient({ events: { insert: { data: null, error: null } } });
  });

  it("eventKind() builds <resource>_<action>", () => {
    expect(eventKind("client", "created")).toBe("client_created");
    expect(eventKind("brief", "archived")).toBe("brief_archived");
    expect(eventKind("creative", "restored")).toBe("creative_restored");
  });

  it("emitEvent inserts a normalized row and returns true", async () => {
    const ok = await emitEvent(supabase as unknown as Admin, {
      kind: "client_created",
      refTable: "clients",
      refId: "c1",
      payload: { name: "Acme" },
    });
    expect(ok).toBe(true);
    expect(supabase._spies.from).toHaveBeenCalledWith("events");
    expect(lastInsertArgs(supabase)).toEqual({
      kind: "client_created",
      ref_table: "clients",
      ref_id: "c1",
      payload: { name: "Acme" },
    });
  });

  it("emitEvent defaults a missing payload to null", async () => {
    await emitEvent(supabase as unknown as Admin, {
      kind: "client_archived",
      refTable: "clients",
      refId: "c1",
    });
    expect(lastInsertArgs(supabase)).toMatchObject({ payload: null });
  });

  it("emitEvent is non-fatal: logs a warning and returns false on error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    supabase = mockClient({ events: { insert: { data: null, error: { message: "no table" } } } });
    const ok = await emitEvent(supabase as unknown as Admin, {
      kind: "client_created",
      refTable: "clients",
      refId: "c1",
    });
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no table"));
    warn.mockRestore();
  });

  it("emitEvents inserts a batch and returns true", async () => {
    const ok = await emitEvents(supabase as unknown as Admin, [
      { kind: "a", refTable: "t", refId: "1" },
      { kind: "b", refTable: "t", refId: "1", payload: { x: 1 } },
    ]);
    expect(ok).toBe(true);
    expect(lastInsertArgs(supabase)).toEqual([
      { kind: "a", ref_table: "t", ref_id: "1", payload: null },
      { kind: "b", ref_table: "t", ref_id: "1", payload: { x: 1 } },
    ]);
  });

  it("emitEvents is a no-op (true) for an empty list", async () => {
    const ok = await emitEvents(supabase as unknown as Admin, []);
    expect(ok).toBe(true);
    expect(supabase._spies.from).not.toHaveBeenCalled();
  });

  it("emitEvents is non-fatal on a batch insert error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    supabase = mockClient({ events: { insert: { data: null, error: { message: "boom" } } } });
    const ok = await emitEvents(supabase as unknown as Admin, [
      { kind: "a", refTable: "t", refId: "1" },
    ]);
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    warn.mockRestore();
  });
});
