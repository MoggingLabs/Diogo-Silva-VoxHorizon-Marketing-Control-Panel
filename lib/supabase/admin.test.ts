import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const createSupabaseClient = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createSupabaseClient(...args),
}));

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test\n";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "  service-role ";
  createSupabaseClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createAdminClient", () => {
  it("constructs a service-role client with auth flags disabled", async () => {
    createSupabaseClient.mockReturnValue("client");
    const { createAdminClient } = await import("./admin");
    const out = createAdminClient();
    expect(out).toBe("client");
    expect(createSupabaseClient).toHaveBeenCalledWith(
      "http://supabase.test",
      "service-role",
      expect.objectContaining({
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
      }),
    );
  });
});
