import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
let currentAdmin: { storage: { from: ReturnType<typeof vi.fn> } };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentAdmin,
}));

vi.mock("@/components/launch/VideoLaunchSummary", () => ({
  VideoLaunchSummary: () => <div data-testid="summary" />,
}));
vi.mock("@/components/launch/VideoLaunchApprovalGate", () => ({
  VideoLaunchApprovalGate: () => <div data-testid="approval-gate" />,
}));
vi.mock("@/components/launch/LaunchTimeline", () => ({
  LaunchTimeline: ({ initialEvents }: { initialEvents: unknown[] }) => (
    <div data-testid="timeline" data-count={initialEvents.length} />
  ),
}));

const notFoundSpy = vi.fn(() => {
  throw new Error("__NOT_FOUND__");
});
vi.mock("next/navigation", () => ({
  notFound: () => notFoundSpy(),
}));

import VideoLaunchDetailPage, { generateMetadata } from "./page";

const validPayload = {
  brief_id_human: "vb-1",
  client: { id: "c", slug: "s", name: "Acme" },
  video_creative_ids: ["11111111-1111-4111-8111-111111111111"],
  copy_variant_ids: ["22222222-2222-4222-9222-222222222222"],
  issues: [],
  validation: { ok: true, via: "preflight" },
};

const launchRow = {
  id: "vl1",
  brief_id: "b1",
  status: "posted",
  payload: validPayload,
  decided_at: null,
  decided_by: null,
  decided_notes: null,
};

function makeAdmin(opts: { url?: string | null; error?: { message: string } | null } = {}) {
  return {
    storage: {
      from: vi.fn(() => ({
        createSignedUrl: vi.fn(async () => ({
          data: opts.url ? { signedUrl: opts.url } : null,
          error: opts.error ?? null,
        })),
      })),
    },
  };
}

describe("VideoLaunchDetailPage", () => {
  it("renders the page chrome + summary + approval gate", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: { data: null, error: null, single: { data: launchRow, error: null } },
      },
      video_briefs: {
        select: {
          data: null,
          error: null,
          single: { data: { id: "b1", clients: { name: "Acme", slug: "acme" } }, error: null },
        },
      },
      video_creatives: {
        select: {
          data: [
            { id: "vc1", captioned_path: "c.mp4" },
            { id: "vc2", captioned_path: null },
          ],
          error: null,
        },
      },
      video_copy_variants: {
        select: { data: [{ id: "cv1", creative_id: "vc1" }], error: null },
      },
      events: { select: { data: [{ id: "e1" }], error: null } },
    });
    currentAdmin = makeAdmin({ url: "https://signed/c.mp4" });
    const el = await VideoLaunchDetailPage({ params: Promise.resolve({ id: "vl1" }) });
    render(el);
    expect(screen.getByTestId("summary")).toBeInTheDocument();
    expect(screen.getByTestId("approval-gate")).toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toHaveAttribute("data-count", "1");
  });

  it("renders the decision banner for approved launches", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              ...launchRow,
              status: "approved",
              decided_at: "2026-05-17T10:00:00Z",
              decided_notes: "ship it",
            },
            error: null,
          },
        },
      },
      video_briefs: {
        select: {
          data: null,
          error: null,
          single: { data: { id: "b1", clients: null }, error: null },
        },
      },
      video_creatives: { select: { data: [], error: null } },
      video_copy_variants: { select: { data: [], error: null } },
      events: { select: { data: [], error: null } },
    });
    currentAdmin = makeAdmin();
    const el = await VideoLaunchDetailPage({ params: Promise.resolve({ id: "vl1" }) });
    render(el);
    expect(screen.getByText("ship it")).toBeInTheDocument();
  });

  it("falls back to null signed URL when storage errors", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: { data: null, error: null, single: { data: launchRow, error: null } },
      },
      video_briefs: {
        select: {
          data: null,
          error: null,
          single: { data: { id: "b1", clients: null }, error: null },
        },
      },
      video_creatives: { select: { data: [{ id: "vc1", captioned_path: "c.mp4" }], error: null } },
      video_copy_variants: { select: { data: [], error: null } },
      events: { select: { data: [], error: null } },
    });
    currentAdmin = makeAdmin({ url: null, error: { message: "no" } });
    const el = await VideoLaunchDetailPage({ params: Promise.resolve({ id: "vl1" }) });
    render(el);
    expect(screen.getByTestId("summary")).toBeInTheDocument();
  });

  it("throws when launch query errors", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: { data: null, error: null, single: { data: null, error: { message: "boom" } } },
      },
    });
    currentAdmin = makeAdmin();
    await expect(VideoLaunchDetailPage({ params: Promise.resolve({ id: "vl1" }) })).rejects.toThrow(
      "boom",
    );
  });

  it("notFounds when launch row is missing", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: { data: null, error: null, single: { data: null, error: null } },
      },
    });
    currentAdmin = makeAdmin();
    await expect(VideoLaunchDetailPage({ params: Promise.resolve({ id: "vl1" }) })).rejects.toThrow(
      "__NOT_FOUND__",
    );
  });

  it("throws when payload fails schema", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: {
          data: null,
          error: null,
          single: { data: { ...launchRow, payload: { bad: 1 } }, error: null },
        },
      },
    });
    currentAdmin = makeAdmin();
    await expect(VideoLaunchDetailPage({ params: Promise.resolve({ id: "vl1" }) })).rejects.toThrow(
      /payload failed schema/,
    );
  });

  it("throws on brief query error", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: { data: null, error: null, single: { data: launchRow, error: null } },
      },
      video_briefs: {
        select: { data: null, error: null, single: { data: null, error: { message: "brf" } } },
      },
      video_creatives: { select: { data: [], error: null } },
      video_copy_variants: { select: { data: [], error: null } },
      events: { select: { data: [], error: null } },
    });
    currentAdmin = makeAdmin();
    await expect(VideoLaunchDetailPage({ params: Promise.resolve({ id: "vl1" }) })).rejects.toThrow(
      "brf",
    );
  });

  it("notFounds when brief is missing", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: { data: null, error: null, single: { data: launchRow, error: null } },
      },
      video_briefs: { select: { data: null, error: null, single: { data: null, error: null } } },
      video_creatives: { select: { data: [], error: null } },
      video_copy_variants: { select: { data: [], error: null } },
      events: { select: { data: [], error: null } },
    });
    currentAdmin = makeAdmin();
    await expect(VideoLaunchDetailPage({ params: Promise.resolve({ id: "vl1" }) })).rejects.toThrow(
      "__NOT_FOUND__",
    );
  });

  it("generateMetadata returns truncated id", async () => {
    const m = await generateMetadata({ params: Promise.resolve({ id: "abcdef12-rest" }) });
    expect(m.title).toBe("Video launch abcdef12 — VoxHorizon");
  });
});
