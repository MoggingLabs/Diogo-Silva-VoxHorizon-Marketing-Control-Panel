/**
 * Tests for `app/api/pipelines/[id]/picks/route.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

// `@/lib/operator/dispatch` imports `server-only`; neutralise it so the jsdom
// route-test project can load the (partially mocked) module.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

// `vi.hoisted` so the spy exists when the hoisted `vi.mock` factory runs.
const { dispatchOperator } = vi.hoisted(() => ({
  dispatchOperator: vi.fn<(id: string, instruction: string) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/operator/dispatch", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/operator/dispatch")>("@/lib/operator/dispatch");
  return { ...actual, dispatchOperator };
});

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });
const creativeUuid = "33333333-3333-4333-8333-333333333333";

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

function flush() {
  return new Promise((r) => setTimeout(r, 5));
}

describe("POST /api/pipelines/:id/picks", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
    dispatchOperator.mockClear();
  });

  it("records image picks (200)", async () => {
    currentSupabase = mockClient({
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
    // Recording picks does NOT dispatch the operator — finals are dispatched
    // only at the Review-approval gate, so picks must never trigger a render.
    await flush();
    expect(dispatchOperator).not.toHaveBeenCalled();
  });

  it("does NOT dispatch the operator when only video picks are recorded", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "ideation",
              format_choice: "video",
              picks: {},
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
    await flush();
    expect(dispatchOperator).not.toHaveBeenCalled();
  });

  it("records video picks (200)", async () => {
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
