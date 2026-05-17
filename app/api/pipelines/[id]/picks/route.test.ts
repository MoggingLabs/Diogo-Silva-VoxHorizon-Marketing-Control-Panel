/**
 * Tests for `app/api/pipelines/[id]/picks/route.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });
const creativeUuid = "33333333-3333-4333-8333-333333333333";

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("POST /api/pipelines/:id/picks", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("records image picks (200)", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "image",
              picks: {},
              image_brief_id: "22222222-2222-4222-8222-222222222222",
              video_brief_id: null,
            },
            error: null,
          },
        },
        update: { single: { data: { id, status: "ideation" }, error: null } },
      },
      creatives: { select: { data: [{ id: creativeUuid }], error: null } },
      pipeline_events: { insert: { data: null, error: null } },
    });

    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ image: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("records video picks (200)", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "video",
              picks: { image: [], video: ["other"] },
              image_brief_id: null,
              video_brief_id: "22222222-2222-4222-8222-222222222222",
            },
            error: null,
          },
        },
        update: { single: { data: { id }, error: null } },
      },
      video_creatives: { select: { data: [{ id: creativeUuid }], error: null } },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ video: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("400 invalid JSON", async () => {
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, { method: "POST", body: "{" }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("400 zod fail (empty)", async () => {
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("500 read error", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ image: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 missing", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ image: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("409 when not in ideation", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: { single: { data: { id, status: "review", format_choice: "image" }, error: null } },
      },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ image: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
  });

  it("422 when image track inactive (format=video) but image present", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "video",
              picks: {},
              video_brief_id: "b1",
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ image: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("422 when video track inactive but video present", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "image",
              picks: {},
              image_brief_id: "b1",
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ video: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("422 when image_brief_id is null but image picks supplied", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "image",
              picks: {},
              image_brief_id: null,
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ image: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("422 when video_brief_id is null but video picks supplied", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "video",
              picks: {},
              video_brief_id: null,
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ video: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("500 when image creatives lookup errors", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "image",
              picks: {},
              image_brief_id: "b1",
            },
            error: null,
          },
        },
      },
      creatives: { select: { data: null, error: { message: "x" } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ image: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("422 when image creatives don't all match", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "image",
              picks: {},
              image_brief_id: "b1",
            },
            error: null,
          },
        },
      },
      creatives: { select: { data: [], error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ image: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("500 when video creatives lookup errors", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "video",
              picks: {},
              video_brief_id: "b1",
            },
            error: null,
          },
        },
      },
      video_creatives: { select: { data: null, error: { message: "x" } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ video: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("422 when video creatives mismatch", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "video",
              picks: {},
              video_brief_id: "b1",
            },
            error: null,
          },
        },
      },
      video_creatives: { select: { data: [], error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ video: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("500 when update fails", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "image",
              picks: {},
              image_brief_id: "b1",
            },
            error: null,
          },
        },
        update: { single: { data: null, error: { message: "race" } } },
      },
      creatives: { select: { data: [{ id: creativeUuid }], error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ image: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("warns when pipeline_events insert fails (still 200)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "image",
              picks: { image: ["other"], video: ["x"] },
              image_brief_id: "b1",
            },
            error: null,
          },
        },
        update: { single: { data: { id }, error: null } },
      },
      creatives: { select: { data: [{ id: creativeUuid }], error: null } },
      pipeline_events: { insert: { data: null, error: { message: "ev down" } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ image: [creativeUuid] }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ev down"));
    warn.mockRestore();
  });

  it("accepts empty image picks (no validation needed)", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "image",
              picks: { image: [creativeUuid] },
              image_brief_id: "b1",
            },
            error: null,
          },
        },
        update: { single: { data: { id }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/picks`, {
        method: "POST",
        body: JSON.stringify({ image: [] }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });
});
