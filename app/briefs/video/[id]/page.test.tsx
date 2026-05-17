import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

vi.mock("@/components/brief/VideoApprovalGate", () => ({
  VideoApprovalGate: () => <div data-testid="approval-gate" />,
}));

vi.mock("@/components/brief/VideoBriefTimeline", () => ({
  VideoBriefTimeline: ({ initialEvents }: { initialEvents: unknown[] }) => (
    <div data-testid="timeline" data-count={initialEvents.length} />
  ),
}));

const notFoundSpy = vi.fn(() => {
  throw new Error("__NOT_FOUND__");
});
vi.mock("next/navigation", () => ({
  notFound: () => notFoundSpy(),
}));

import VideoBriefDetailPage from "./page";

const goodOutline = {
  hook: "Hello there friend",
  segments: [
    { topic: "Intro", duration_s: 10 },
    { topic: "Body", duration_s: 20, broll_theme: "office" },
  ],
};

const baseRow = {
  id: "v1",
  brief_id_human: "vb-1",
  status: "draft",
  target_duration_s: 30,
  dimensions: "9x16",
  voice_id: "bran",
  script_outline: goodOutline,
  hook_style: "curiosity",
  captions_style: "bold_yellow",
  music_track: null,
  broll_selection_mode: "review_each",
  decided_at: null,
  decided_by: null,
  decided_notes: null,
  clients: { name: "Acme", slug: "acme" },
};

describe("VideoBriefDetailPage", () => {
  it("renders header + outline + style + timeline for a draft brief", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { data: null, error: null, single: { data: baseRow, error: null } } },
      events: {
        select: {
          data: [{ id: "e1", kind: "created", created_at: "2026-05-17T00:00:00Z", payload: {} }],
          error: null,
        },
      },
    });
    const el = await VideoBriefDetailPage({ params: Promise.resolve({ id: "v1" }) });
    render(el);
    expect(screen.getByText("vb-1")).toBeInTheDocument();
    expect(screen.getByText("Hello there friend")).toBeInTheDocument();
    expect(screen.getByText(/1\. Intro/)).toBeInTheDocument();
    expect(screen.getByText(/B-roll: office/)).toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toHaveAttribute("data-count", "1");
  });

  it("shows the approval gate for posted briefs", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: {
        select: {
          data: null,
          error: null,
          single: { data: { ...baseRow, status: "posted" }, error: null },
        },
      },
    });
    const el = await VideoBriefDetailPage({ params: Promise.resolve({ id: "v1" }) });
    render(el);
    expect(screen.getByTestId("approval-gate")).toBeInTheDocument();
  });

  it("renders the decision banner for decided briefs", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              ...baseRow,
              status: "approved",
              decided_at: "2026-05-17T10:00:00Z",
              decided_by: "alice",
              decided_notes: "looks good",
            },
            error: null,
          },
        },
      },
    });
    const el = await VideoBriefDetailPage({ params: Promise.resolve({ id: "v1" }) });
    render(el);
    expect(screen.getByText(/by alice/)).toBeInTheDocument();
    expect(screen.getByText(/looks good/)).toBeInTheDocument();
  });

  it("renders a fallback when the script_outline is malformed", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: {
        select: {
          data: null,
          error: null,
          single: {
            data: { ...baseRow, script_outline: { wrong: true } },
            error: null,
          },
        },
      },
    });
    const el = await VideoBriefDetailPage({ params: Promise.resolve({ id: "v1" }) });
    render(el);
    expect(screen.getByText(/No structured script outline saved/i)).toBeInTheDocument();
  });

  it("renders the error banner when the brief query errors", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: {
        select: { data: null, error: null, single: { data: null, error: { message: "boom" } } },
      },
    });
    const el = await VideoBriefDetailPage({ params: Promise.resolve({ id: "v1" }) });
    render(el);
    expect(screen.getByRole("alert")).toHaveTextContent(/boom/);
  });

  it("calls notFound when the brief is missing", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { data: null, error: null, single: { data: null, error: null } } },
    });
    await expect(VideoBriefDetailPage({ params: Promise.resolve({ id: "v1" }) })).rejects.toThrow(
      "__NOT_FOUND__",
    );
  });
});
