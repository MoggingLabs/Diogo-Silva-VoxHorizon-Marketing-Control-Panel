import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Neutralise the `server-only` sentinel so this module can be loaded inside
// the node test project.
vi.mock("server-only", () => ({}));

const createServerClient = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: (...args: unknown[]) => createServerClient(...args),
}));

const getAll = vi.fn(() => [{ name: "sb-auth", value: "v", options: {} }]);
const setSpy = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => getAll(),
    set: (name: string, value: string, options: unknown) => setSpy(name, value, options),
  }),
}));

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test ";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon\n";
  createServerClient.mockReset();
  getAll.mockClear();
  setSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createClient", () => {
  it("wires cleaned env + cookie callbacks", async () => {
    createServerClient.mockReturnValue("client");
    const { createClient } = await import("./server");
    const client = await createClient();
    expect(client).toBe("client");
    expect(createServerClient).toHaveBeenCalledWith(
      "http://supabase.test",
      "anon",
      expect.any(Object),
    );

    const args = createServerClient.mock.calls[0]?.[2] as {
      cookies: {
        getAll: () => unknown;
        setAll: (cookies: { name: string; value: string; options?: unknown }[]) => void;
      };
    };
    // getAll proxies to the next/headers cookieStore.
    expect(args.cookies.getAll()).toEqual([{ name: "sb-auth", value: "v", options: {} }]);
    expect(getAll).toHaveBeenCalled();

    // setAll forwards each item to cookieStore.set.
    args.cookies.setAll([
      { name: "sb-auth", value: "v2", options: { httpOnly: true } },
      { name: "other", value: "x" },
    ]);
    expect(setSpy).toHaveBeenCalledTimes(2);
    expect(setSpy).toHaveBeenNthCalledWith(1, "sb-auth", "v2", { httpOnly: true });
  });

  it("swallows the ReadOnly cookie error from a Server Component", async () => {
    createServerClient.mockReturnValue("client");
    setSpy.mockImplementationOnce(() => {
      throw new Error("read-only");
    });
    const { createClient } = await import("./server");
    await createClient();

    const args = createServerClient.mock.calls[0]?.[2] as {
      cookies: {
        setAll: (cookies: { name: string; value: string; options?: unknown }[]) => void;
      };
    };

    // Should not throw — the catch silently swallows the read-only error.
    expect(() => args.cookies.setAll([{ name: "sb-auth", value: "v", options: {} }])).not.toThrow();
  });
});
