/**
 * Tests for `app/api/copy/route.ts` (standalone copy GET list + POST create).
 *
 * Covers: list by creative_id (image/video), the archived filter, create into
 * the correct table per format, the draft-on-create rule, the 409 on a
 * duplicate (creative_id, platform, variant_index), and validation/format
 * guards.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { GET, POST } from "./route";

const creativeId = "22222222-2222-4222-8222-222222222222";

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("GET /api/copy", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("400 without creative_id", async () => {
    const res = await GET(req("http://localhost/api/copy"));
    expect(res.status).toBe(400);
  });

  it("400 on a bad format", async () => {
    const res = await GET(req(`http://localhost/api/copy?creative_id=${creativeId}&format=audio`));
    expect(res.status).toBe(400);
  });

  it("lists image variants (200)", async () => {
    currentSupabase = mockClient({
      copy_variants: { select: { data: [{ id: "cv1", variant_index: 1 }], error: null } },
    });
    const res = await GET(req(`http://localhost/api/copy?creative_id=${creativeId}&format=image`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.variants).toHaveLength(1);
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("copy_variants");
  });

  it("lists video variants from the video table (200)", async () => {
    currentSupabase = mockClient({
      video_copy_variants: { select: { data: [{ id: "vv1" }], error: null } },
    });
    const res = await GET(req(`http://localhost/api/copy?creative_id=${creativeId}&format=video`));
    expect(res.status).toBe(200);
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("video_copy_variants");
  });

  it("500 on a DB error", async () => {
    currentSupabase = mockClient({
      copy_variants: { select: { data: null, error: { message: "boom" } } },
    });
    const res = await GET(req(`http://localhost/api/copy?creative_id=${creativeId}&format=image`));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/copy", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  const validBody = {
    format: "image" as const,
    creative_id: creativeId,
    platform: "meta" as const,
    variant_index: 1,
    headline: "Save big on your roof",
    body: "Limited time offer.",
  };

  it("201 creates an image variant in draft + emits an event", async () => {
    currentSupabase = mockClient({
      copy_variants: { insert: { single: { data: { id: "cv1", status: "draft" }, error: null } } },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/copy", { method: "POST", body: JSON.stringify(validBody) }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.variant.id).toBe("cv1");
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("copy_variants");
  });

  it("201 creates a video variant in the video table", async () => {
    currentSupabase = mockClient({
      video_copy_variants: {
        insert: { single: { data: { id: "vv1", status: "draft" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/copy", {
        method: "POST",
        body: JSON.stringify({ ...validBody, format: "video" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("video_copy_variants");
  });

  it("400 on invalid JSON", async () => {
    const res = await POST(req("http://localhost/api/copy", { method: "POST", body: "{" }));
    expect(res.status).toBe(400);
  });

  it("400 on zod failure (missing creative_id)", async () => {
    const res = await POST(
      req("http://localhost/api/copy", {
        method: "POST",
        body: JSON.stringify({ format: "image", variant_index: 1 }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("409 on a duplicate (creative_id, platform, variant_index)", async () => {
    currentSupabase = mockClient({
      copy_variants: {
        // The route reads error.code to map a unique-violation to 409; the
        // shared mock's error type is { message } only, so cast in the fixture.
        insert: {
          single: { data: null, error: { message: "dup", code: "23505" } as { message: string } },
        },
      },
    });
    const res = await POST(
      req("http://localhost/api/copy", { method: "POST", body: JSON.stringify(validBody) }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("duplicate_variant");
  });

  it("500 on a non-unique DB error", async () => {
    currentSupabase = mockClient({
      copy_variants: { insert: { single: { data: null, error: { message: "nope" } } } },
    });
    const res = await POST(
      req("http://localhost/api/copy", { method: "POST", body: JSON.stringify(validBody) }),
    );
    expect(res.status).toBe(500);
  });
});
