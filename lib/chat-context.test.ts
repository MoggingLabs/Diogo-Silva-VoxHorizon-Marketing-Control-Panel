import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DEFAULT_LIMIT_CHAT,
  DEFAULT_LIMIT_ITERATIONS,
  buildChatContext,
  getAvailableTools,
} from "./chat-context";
import {
  mockSupabaseClient as makeMockSupabaseClient,
  type SupabaseMockConfig,
} from "@/tests/unit/helpers/supabase-mock";

// The helper's `SupabaseTableConfig.select` type requires top-level
// `data` + `error` fields, but the helper reads them defensively. Wrap
// the call so tests can pass `single`-only configs without scattering
// `null` placeholders everywhere.
function mockSupabaseClient(config: Record<string, unknown> = {}) {
  return makeMockSupabaseClient(config as SupabaseMockConfig);
}

describe("getAvailableTools", () => {
  it("returns the image tool registry for image creatives", () => {
    const tools = getAvailableTools("image");
    expect(tools.map((t) => t.name)).toEqual(["regenerate", "composite"]);
  });

  it("returns the video tool registry for video creatives", () => {
    const tools = getAvailableTools("video");
    expect(tools.map((t) => t.name)).toEqual([
      "rewrite_script",
      "regenerate_voiceover",
      "swap_broll",
      "rerender",
      "recaption",
    ]);
  });
});

describe("buildChatContext defaults", () => {
  it("exposes the rolling-window defaults", () => {
    expect(DEFAULT_LIMIT_ITERATIONS).toBe(5);
    expect(DEFAULT_LIMIT_CHAT).toBe(10);
  });
});

describe("buildChatContext (image path)", () => {
  it("hydrates creative + brief + iterations + chat history", async () => {
    const supabase = mockSupabaseClient({
      creatives: {
        select: {
          single: {
            data: {
              id: "c1",
              brief_id: "b1",
              status: "draft",
              created_at: "2026-05-17T10:00:00Z",
              concept: "kitchen reno",
              offer_text: "$1k off",
              ratio: "1x1",
              version: "v1.0",
              file_path_supabase: "c1.png",
              prompt_used: "modern",
            },
            error: null,
          },
        },
      },
      briefs: {
        select: {
          single: {
            data: { id: "b1", status: "approved", payload: { service: "roofing" } },
            error: null,
          },
        },
      },
      creative_iterations: {
        select: {
          data: [
            { kind: "generate", author: "ekko", created_at: "2026-05-17T11:00:00Z", content: {} },
            { kind: "comment", author: "user", created_at: "2026-05-17T10:30:00Z", content: "hi" },
          ],
          error: null,
        },
      },
      chat_messages: {
        select: {
          data: [
            {
              author: "user",
              content_type: "text",
              content: "hi",
              created_at: "2026-05-17T10:00:00Z",
            },
          ],
          error: null,
        },
      },
    });

    const ctx = await buildChatContext(supabase as never, {
      creative_id: "c1",
      creative_type: "image",
    });

    expect(ctx.creative.type).toBe("image");
    expect(ctx.creative.id).toBe("c1");
    expect(ctx.creative.extra).toMatchObject({ concept: "kitchen reno" });
    expect(ctx.brief.id).toBe("b1");
    expect(ctx.brief.payload).toEqual({ service: "roofing" });
    // Iterations are returned chronological (oldest first) after reversal.
    expect(ctx.iterations.map((i) => i.kind)).toEqual(["comment", "generate"]);
    expect(ctx.chat_history.map((m) => m.content)).toEqual(["hi"]);
    expect(ctx.available_tools.length).toBeGreaterThan(0);
  });

  it("normalises a scalar-shaped brief payload", async () => {
    const supabase = mockSupabaseClient({
      creatives: {
        select: {
          single: {
            data: {
              id: "c1",
              brief_id: "b1",
              status: "draft",
              created_at: "2026-05-17T10:00:00Z",
            },
            error: null,
          },
        },
      },
      briefs: {
        select: {
          single: {
            data: { id: "b1", status: "approved", payload: "scalar" },
            error: null,
          },
        },
      },
    });

    const ctx = await buildChatContext(supabase as never, {
      creative_id: "c1",
      creative_type: "image",
    });
    expect(ctx.brief.payload).toEqual({ value: "scalar" });
  });

  it("throws when the creative is missing", async () => {
    const supabase = mockSupabaseClient({
      creatives: { select: { single: { data: null, error: null } } },
    });
    await expect(
      buildChatContext(supabase as never, { creative_id: "x", creative_type: "image" }),
    ).rejects.toThrow(/not found/);
  });

  it("throws on a creative-load DB error", async () => {
    const supabase = mockSupabaseClient({
      creatives: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    await expect(
      buildChatContext(supabase as never, { creative_id: "x", creative_type: "image" }),
    ).rejects.toThrow(/load image creative.*boom/);
  });

  it("throws when the brief lookup fails after the creative loads", async () => {
    const supabase = mockSupabaseClient({
      creatives: {
        select: {
          single: {
            data: {
              id: "c1",
              brief_id: "b1",
              status: "draft",
              created_at: "2026-05-17T10:00:00Z",
            },
            error: null,
          },
        },
      },
      briefs: { select: { single: { data: null, error: { message: "no" } } } },
    });
    await expect(
      buildChatContext(supabase as never, { creative_id: "c1", creative_type: "image" }),
    ).rejects.toThrow(/load brief: no/);
  });

  it("throws when the brief is missing", async () => {
    const supabase = mockSupabaseClient({
      creatives: {
        select: {
          single: {
            data: {
              id: "c1",
              brief_id: "b1",
              status: "draft",
              created_at: "2026-05-17T10:00:00Z",
            },
            error: null,
          },
        },
      },
      briefs: { select: { single: { data: null, error: null } } },
    });
    await expect(
      buildChatContext(supabase as never, { creative_id: "c1", creative_type: "image" }),
    ).rejects.toThrow(/brief b1 not found/);
  });

  it("propagates iteration/chat load errors", async () => {
    const supabase = mockSupabaseClient({
      creatives: {
        select: {
          single: {
            data: {
              id: "c1",
              brief_id: "b1",
              status: "draft",
              created_at: "2026-05-17T10:00:00Z",
            },
            error: null,
          },
        },
      },
      briefs: {
        select: {
          data: null,
          error: null,
          single: { data: { id: "b1", status: "approved", payload: {} }, error: null },
        },
      },
      creative_iterations: { select: { data: null, error: { message: "iter-err" } } },
    });
    await expect(
      buildChatContext(supabase as never, { creative_id: "c1", creative_type: "image" }),
    ).rejects.toThrow(/load iterations: iter-err/);
  });

  it("propagates chat history errors", async () => {
    const supabase = mockSupabaseClient({
      creatives: {
        select: {
          single: {
            data: {
              id: "c1",
              brief_id: "b1",
              status: "draft",
              created_at: "2026-05-17T10:00:00Z",
            },
            error: null,
          },
        },
      },
      briefs: {
        select: {
          data: null,
          error: null,
          single: { data: { id: "b1", status: "approved", payload: {} }, error: null },
        },
      },
      chat_messages: { select: { data: null, error: { message: "chat-err" } } },
    });
    await expect(
      buildChatContext(supabase as never, { creative_id: "c1", creative_type: "image" }),
    ).rejects.toThrow(/load chat history: chat-err/);
  });
});

describe("buildChatContext (video path)", () => {
  it("hydrates the video creative + video brief", async () => {
    const supabase = mockSupabaseClient({
      video_creatives: {
        select: {
          single: {
            data: {
              id: "v1",
              brief_id: "vb1",
              status: "draft",
              created_at: "2026-05-17T10:00:00Z",
              version: 1,
              script_path: null,
              voiceover_path: null,
              broll_clips: null,
              composed_path: null,
              captioned_path: null,
              drive_url: null,
              duration_actual_s: null,
            },
            error: null,
          },
        },
      },
      video_briefs: {
        select: {
          single: {
            data: { id: "vb1", status: "approved", payload: { service: "video" } },
            error: null,
          },
        },
      },
    });

    const ctx = await buildChatContext(supabase as never, {
      creative_id: "v1",
      creative_type: "video",
    });
    expect(ctx.creative.type).toBe("video");
    expect(ctx.brief.id).toBe("vb1");
  });

  it("throws when the video creative load errors", async () => {
    const supabase = mockSupabaseClient({
      video_creatives: { select: { single: { data: null, error: { message: "ouch" } } } },
    });
    await expect(
      buildChatContext(supabase as never, { creative_id: "v1", creative_type: "video" }),
    ).rejects.toThrow(/load video creative: ouch/);
  });

  it("throws when the video creative is missing", async () => {
    const supabase = mockSupabaseClient({
      video_creatives: { select: { single: { data: null, error: null } } },
    });
    await expect(
      buildChatContext(supabase as never, { creative_id: "v1", creative_type: "video" }),
    ).rejects.toThrow(/video creative v1 not found/);
  });

  it("throws when the video brief load errors", async () => {
    const supabase = mockSupabaseClient({
      video_creatives: {
        select: {
          single: {
            data: {
              id: "v1",
              brief_id: "vb1",
              status: "draft",
              created_at: "2026-05-17T10:00:00Z",
            },
            error: null,
          },
        },
      },
      video_briefs: { select: { single: { data: null, error: { message: "vb-err" } } } },
    });
    await expect(
      buildChatContext(supabase as never, { creative_id: "v1", creative_type: "video" }),
    ).rejects.toThrow(/load video brief: vb-err/);
  });

  it("throws when the video brief is missing", async () => {
    const supabase = mockSupabaseClient({
      video_creatives: {
        select: {
          single: {
            data: {
              id: "v1",
              brief_id: "vb1",
              status: "draft",
              created_at: "2026-05-17T10:00:00Z",
            },
            error: null,
          },
        },
      },
      video_briefs: { select: { single: { data: null, error: null } } },
    });
    await expect(
      buildChatContext(supabase as never, { creative_id: "v1", creative_type: "video" }),
    ).rejects.toThrow(/video brief vb1 not found/);
  });
});
