import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Neutralise the `server-only` sentinel so this module can be loaded inside
// the node test project.
vi.mock("server-only", () => ({}));

const createClient = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClient(...args),
}));

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test ";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test\n";
  createClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createClient (server, service-role)", () => {
  it("builds a service-role client with cleaned env + no session persistence", async () => {
    createClient.mockReturnValue("client");
    const { createClient: make } = await import("./server");
    const client = await make();
    expect(client).toBe("client");

    // URL + the SERVICE-ROLE key (not the anon key) are passed, trimmed.
    expect(createClient).toHaveBeenCalledWith(
      "http://supabase.test",
      "sb_secret_test",
      expect.objectContaining({
        auth: expect.objectContaining({
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        }),
      }),
    );
  });

  it("does NOT read the public anon key", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-should-not-be-used";
    createClient.mockReturnValue("client");
    const { createClient: make } = await import("./server");
    await make();
    const keyArg = createClient.mock.calls[0]?.[1];
    expect(keyArg).toBe("sb_secret_test");
    expect(keyArg).not.toBe("anon-should-not-be-used");
  });

  it("throws when SUPABASE_SECRET_KEY is missing", async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    const { createClient: make } = await import("./server");
    await expect(make()).rejects.toThrow(/SUPABASE_SECRET_KEY/);
  });
});
