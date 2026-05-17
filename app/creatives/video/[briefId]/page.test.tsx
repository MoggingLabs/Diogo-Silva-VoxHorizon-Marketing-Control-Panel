import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
let currentAdmin: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentAdmin,
}));

vi.mock("@/lib/video-creatives", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/video-creatives")>("@/lib/video-creatives");
  return {
    ...actual,
    getSignedUrl: vi.fn(async (_client, path: string | null) =>
      path ? `https://signed/${path}` : null,
    ),
  };
});

vi.mock("@/components/creative/VideoVariantsGrid", () => ({
  VideoVariantsGrid: ({
    initialCreatives,
    selectedId,
  }: {
    initialCreatives: { id: string }[];
    selectedId: string | null;
  }) => (
    <div data-testid="grid" data-count={initialCreatives.length} data-selected={selectedId ?? ""} />
  ),
}));

const notFoundSpy = vi.fn(() => {
  throw new Error("__NOT_FOUND__");
});
vi.mock("next/navigation", () => ({
  notFound: () => notFoundSpy(),
}));

import VideoCreativesByBriefPage, { generateMetadata } from "./page";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

const briefRow = {
  id: VALID_UUID,
  brief_id_human: "vb-1",
  status: "approved",
  client_id: "c1",
  target_duration_s: 30,
  dimensions: "9x16",
  voice_id: "bran",
  script_outline: {
    hook: "Hello there",
    segments: [{ topic: "Intro", duration_s: 30 }],
  },
};

describe("VideoCreativesByBriefPage", () => {
  it("renders header + meta + variants grid", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: {
        select: { data: null, error: null, single: { data: briefRow, error: null } },
      },
      clients: {
        select: {
          data: null,
          error: null,
          single: { data: { id: "c1", name: "Acme", slug: "acme" }, error: null },
        },
      },
      video_creatives: {
        select: {
          data: [
            {
              id: "vc1",
              status: "draft",
              captioned_path: null,
              composed_path: null,
              voiceover_path: null,
            },
            {
              id: "vc2",
              status: "captioned",
              captioned_path: "p1.mp4",
              composed_path: null,
              voiceover_path: null,
            },
          ],
          error: null,
        },
      },
    });
    currentAdmin = mockSupabaseClient();
    const el = await VideoCreativesByBriefPage({
      params: Promise.resolve({ briefId: VALID_UUID }),
      searchParams: Promise.resolve({}),
    });
    render(el);
    expect(screen.getByRole("heading", { name: /video creative variants/i })).toBeInTheDocument();
    expect(screen.getByTestId("grid")).toHaveAttribute("data-count", "2");
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("falls back to human id lookup", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: {
        select: {
          data: null,
          error: null,
          single: { data: { ...briefRow, client_id: null }, error: null },
        },
      },
      video_creatives: { select: { data: [], error: null } },
    });
    currentAdmin = mockSupabaseClient();
    const el = await VideoCreativesByBriefPage({
      params: Promise.resolve({ briefId: "vb-1" }),
      searchParams: Promise.resolve({}),
    });
    render(el);
    expect(screen.getByText("No client")).toBeInTheDocument();
  });

  it("ignores ?creative when not a uuid", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: {
        select: {
          data: null,
          error: null,
          single: { data: { ...briefRow, client_id: null }, error: null },
        },
      },
      video_creatives: { select: { data: [], error: null } },
    });
    currentAdmin = mockSupabaseClient();
    const el = await VideoCreativesByBriefPage({
      params: Promise.resolve({ briefId: VALID_UUID }),
      searchParams: Promise.resolve({ creative: "not-uuid" }),
    });
    render(el);
    expect(screen.getByTestId("grid")).toHaveAttribute("data-selected", "");
  });

  it("respects ?creative=uuid", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: {
        select: {
          data: null,
          error: null,
          single: { data: { ...briefRow, client_id: null }, error: null },
        },
      },
      video_creatives: { select: { data: [], error: null } },
    });
    currentAdmin = mockSupabaseClient();
    const el = await VideoCreativesByBriefPage({
      params: Promise.resolve({ briefId: VALID_UUID }),
      searchParams: Promise.resolve({ creative: VALID_UUID }),
    });
    render(el);
    expect(screen.getByTestId("grid")).toHaveAttribute("data-selected", VALID_UUID);
  });

  it("throws when brief lookup errors", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: {
        select: { data: null, error: null, single: { data: null, error: { message: "bad" } } },
      },
    });
    currentAdmin = mockSupabaseClient();
    await expect(
      VideoCreativesByBriefPage({
        params: Promise.resolve({ briefId: VALID_UUID }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("bad");
  });

  it("notFounds when no brief", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { data: null, error: null, single: { data: null, error: null } } },
    });
    currentAdmin = mockSupabaseClient();
    await expect(
      VideoCreativesByBriefPage({
        params: Promise.resolve({ briefId: VALID_UUID }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("__NOT_FOUND__");
  });

  it("throws when video_creatives query errors", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: {
        select: { data: null, error: null, single: { data: briefRow, error: null } },
      },
      video_creatives: { select: { data: null, error: { message: "boom" } } },
    });
    currentAdmin = mockSupabaseClient();
    await expect(
      VideoCreativesByBriefPage({
        params: Promise.resolve({ briefId: VALID_UUID }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("boom");
  });

  it("generateMetadata returns truncated id", async () => {
    const m = await generateMetadata({
      params: Promise.resolve({ briefId: VALID_UUID }),
      searchParams: Promise.resolve({}),
    });
    expect(m.title).toMatch(/Video creatives 11111111-111/);
  });
});
