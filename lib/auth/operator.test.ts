/**
 * Tests for the single-operator lookup (lib/auth/operator).
 *
 * The DB read is service-role (RLS deny-all on `operators`, migration 0057),
 * so we mock `createAdminClient` with the shared supabase mock and assert the
 * helper's normalisation + error handling rather than hitting Postgres.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { mockSupabaseClient } from "@/tests/unit/helpers/supabase-mock";

import { findOperatorByEmail } from "./operator";

const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "operator@example.com",
  password_hash: "$2a$10$hash",
};

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("findOperatorByEmail", () => {
  it("returns the operator row on a hit", async () => {
    const supabase = mockSupabaseClient({
      operators: { select: { data: ROW, error: null, single: { data: ROW, error: null } } },
    });
    vi.mocked(createAdminClient).mockReturnValue(supabase as never);

    const row = await findOperatorByEmail("Operator@Example.com");
    expect(row).toEqual(ROW);
    // Lookup runs against the lowercased + trimmed email.
    expect(supabase.from).toHaveBeenCalledWith("operators");
  });

  it("returns null when no operator matches", async () => {
    const supabase = mockSupabaseClient({
      operators: { select: { data: null, error: null, single: { data: null, error: null } } },
    });
    vi.mocked(createAdminClient).mockReturnValue(supabase as never);

    expect(await findOperatorByEmail("nobody@example.com")).toBeNull();
  });

  it("returns null for a blank email without touching the DB", async () => {
    const supabase = mockSupabaseClient({});
    vi.mocked(createAdminClient).mockReturnValue(supabase as never);

    expect(await findOperatorByEmail("   ")).toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("throws when the query errors", async () => {
    const supabase = mockSupabaseClient({
      operators: {
        select: {
          data: null,
          error: { message: "boom" },
          single: { data: null, error: { message: "boom" } },
        },
      },
    });
    vi.mocked(createAdminClient).mockReturnValue(supabase as never);

    await expect(findOperatorByEmail("operator@example.com")).rejects.toThrow(/boom/);
  });
});
