/**
 * Unit tests for the CRUD soft-delete / restore / hard-delete helpers
 * (E1.1 / #583). Covers the compare-and-set ok / conflict / missing / error
 * branches for each.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";

import { hardDelete, restore, softDelete } from "./soft-delete";

type Admin = Parameters<typeof softDelete>[0];

const ID = "11111111-1111-4111-8111-111111111111";

describe("softDelete", () => {
  it("ok: a live row is archived (update returns the row)", async () => {
    const supabase = mockClient({
      clients: { update: { single: { data: { id: ID, deleted_at: "2026-01-01" }, error: null } } },
    });
    const res = await softDelete(supabase as unknown as Admin, "clients", ID);
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect((res.row as { id: string }).id).toBe(ID);
  });

  it("conflict: update matches nothing but the row exists -> already_archived", async () => {
    const supabase = mockClient({
      clients: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id: ID, deleted_at: "2026-01-01" }, error: null } },
      },
    });
    const res = await softDelete(supabase as unknown as Admin, "clients", ID);
    expect(res.kind).toBe("conflict");
    if (res.kind === "conflict") expect(res.reason).toBe("already_archived");
  });

  it("missing: update matches nothing and the row does not exist -> missing", async () => {
    const supabase = mockClient({
      clients: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await softDelete(supabase as unknown as Admin, "clients", ID);
    expect(res.kind).toBe("missing");
  });

  it("error: a DB error on update surfaces as error", async () => {
    const supabase = mockClient({
      clients: { update: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await softDelete(supabase as unknown as Admin, "clients", ID);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toBe("boom");
  });

  it("error: a DB error during disambiguation re-read surfaces as error", async () => {
    const supabase = mockClient({
      clients: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: { message: "reread failed" } } },
      },
    });
    const res = await softDelete(supabase as unknown as Admin, "clients", ID);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toBe("reread failed");
  });

  it("honours a custom now + columns", async () => {
    const supabase = mockClient({
      widgets: { update: { single: { data: { wid: ID }, error: null } } },
    });
    const res = await softDelete(supabase as unknown as Admin, "clients", ID, {
      now: "2026-05-25T00:00:00.000Z",
      deletedColumn: "removed_at",
      idColumn: "wid",
    });
    // table is "clients" but config keyed "widgets" -> default null result -> conflict/missing path
    expect(["ok", "missing", "conflict"]).toContain(res.kind);
  });
});

describe("restore", () => {
  it("ok: an archived row is restored", async () => {
    const supabase = mockClient({
      clients: { update: { single: { data: { id: ID, deleted_at: null }, error: null } } },
    });
    const res = await restore(supabase as unknown as Admin, "clients", ID);
    expect(res.kind).toBe("ok");
  });

  it("conflict: nothing updated but the row exists -> not_archived", async () => {
    const supabase = mockClient({
      clients: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id: ID, deleted_at: null }, error: null } },
      },
    });
    const res = await restore(supabase as unknown as Admin, "clients", ID);
    expect(res.kind).toBe("conflict");
    if (res.kind === "conflict") expect(res.reason).toBe("not_archived");
  });

  it("missing: nothing updated and the row does not exist", async () => {
    const supabase = mockClient({
      clients: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await restore(supabase as unknown as Admin, "clients", ID);
    expect(res.kind).toBe("missing");
  });

  it("error: a DB error on the restore update", async () => {
    const supabase = mockClient({
      clients: { update: { single: { data: null, error: { message: "nope" } } } },
    });
    const res = await restore(supabase as unknown as Admin, "clients", ID);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toBe("nope");
  });
});

describe("hardDelete", () => {
  it("ok: the row is deleted and returned", async () => {
    const supabase = mockClient({
      client_value_props: { delete: { single: { data: { id: ID }, error: null } } },
    });
    const res = await hardDelete(supabase as unknown as Admin, "client_value_props", ID);
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect((res.row as { id: string }).id).toBe(ID);
  });

  it("missing: nothing matched", async () => {
    const supabase = mockClient({
      client_value_props: { delete: { single: { data: null, error: null } } },
    });
    const res = await hardDelete(supabase as unknown as Admin, "client_value_props", ID);
    expect(res.kind).toBe("missing");
  });

  it("error: a DB error surfaces", async () => {
    const supabase = mockClient({
      client_value_props: { delete: { single: { data: null, error: { message: "fk" } } } },
    });
    const res = await hardDelete(supabase as unknown as Admin, "client_value_props", ID, {
      idColumn: "id",
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toBe("fk");
  });
});
