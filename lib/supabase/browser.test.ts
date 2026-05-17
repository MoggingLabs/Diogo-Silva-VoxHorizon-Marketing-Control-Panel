import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createBrowserClient = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createBrowserClient: (...args: unknown[]) => createBrowserClient(...args),
}));

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test  ";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key\n";
  createBrowserClient.mockReset();
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  vi.restoreAllMocks();
});

describe("browser createClient", () => {
  it("passes trimmed URL + anon key", async () => {
    createBrowserClient.mockReturnValue("client");
    const { createClient } = await import("./browser");
    const out = createClient();
    expect(out).toBe("client");
    expect(createBrowserClient).toHaveBeenCalledWith("http://supabase.test", "anon-key");
  });

  it("falls back to empty strings when env vars are unset", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    createBrowserClient.mockReturnValue("client");
    const { createClient } = await import("./browser");
    createClient();
    expect(createBrowserClient).toHaveBeenCalledWith("", "");
  });
});
