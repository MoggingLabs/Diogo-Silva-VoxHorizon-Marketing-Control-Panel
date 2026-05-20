import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createSignedUrls = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ createSignedUrls }) },
  }),
}));

import { POST } from "./route";

function req(body: unknown): Request {
  return new Request("http://x/api/storage/sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  createSignedUrls.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/storage/sign", () => {
  it("400s on invalid JSON", async () => {
    const bad = new Request("http://x/api/storage/sign", { method: "POST", body: "{not json" });
    const res = await POST(bad as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });

  it("400s on a disallowed bucket", async () => {
    const res = await POST(req({ bucket: "secrets", paths: ["a"] }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_bucket");
  });

  it("400s when paths is not an array", async () => {
    const res = await POST(req({ bucket: "creatives", paths: "a.png" }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_paths");
  });

  it("returns {} for an empty path list without signing", async () => {
    const res = await POST(req({ bucket: "creatives", paths: [] }) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ urls: {} });
    expect(createSignedUrls).not.toHaveBeenCalled();
  });

  it("400s when too many paths are requested", async () => {
    const paths = Array.from({ length: 101 }, (_, i) => `p${i}.png`);
    const res = await POST(req({ bucket: "creatives", paths }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("too_many_paths");
  });

  it("signs a deduped batch and returns a per-path map (null for failures)", async () => {
    createSignedUrls.mockResolvedValue({
      data: [
        { path: "a.png", signedUrl: "https://x/a" },
        { path: "b.png", signedUrl: null },
      ],
      error: null,
    });
    const res = await POST(
      req({ bucket: "creatives", paths: ["a.png", "a.png", "b.png"], expiresIn: 600 }) as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ urls: { "a.png": "https://x/a", "b.png": null } });
    // Deduped + clamped TTL passed through.
    expect(createSignedUrls).toHaveBeenCalledWith(["a.png", "b.png"], 600);
  });

  it("clamps an out-of-range TTL", async () => {
    createSignedUrls.mockResolvedValue({ data: [{ path: "a.png", signedUrl: "u" }], error: null });
    await POST(req({ bucket: "creatives", paths: ["a.png"], expiresIn: 10 }) as never);
    expect(createSignedUrls).toHaveBeenCalledWith(["a.png"], 60); // floored to MIN
  });

  it("ensures a key per requested path even if the API omits it", async () => {
    createSignedUrls.mockResolvedValue({ data: [], error: null });
    const res = await POST(req({ bucket: "creatives", paths: ["a.png"] }) as never);
    expect(await res.json()).toEqual({ urls: { "a.png": null } });
  });

  it("500s when the storage API errors", async () => {
    createSignedUrls.mockResolvedValue({ data: null, error: { message: "kaboom" } });
    const res = await POST(req({ bucket: "creatives", paths: ["a.png"] }) as never);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("kaboom");
  });
});
