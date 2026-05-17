import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

vi.mock("@/components/brief/ApprovalGate", () => ({
  ApprovalGate: () => <div data-testid="approval-gate" />,
}));
vi.mock("@/components/brief/BriefTimeline", () => ({
  BriefTimeline: ({ initialEvents }: { initialEvents: unknown[] }) => (
    <div data-testid="timeline" data-count={initialEvents.length} />
  ),
}));

const notFoundSpy = vi.fn(() => {
  throw new Error("__NOT_FOUND__");
});
vi.mock("next/navigation", () => ({
  notFound: () => notFoundSpy(),
}));

import BriefDetailPage, { generateMetadata } from "./page";

const validPayload = {
  service: "roofing",
  budget: 1000,
  budget_daily: 100,
  market: "Austin",
  creative_plan: { image_count: 3 },
  landing_page_url: "https://example.com",
  offer_text: "$500 off",
  targeting: { radius_km: 50, zips: ["12345"], age_min: 21, age_max: 65 },
  angles: ["fast", "cheap"],
  notes: "test notes",
};

const baseRow = {
  id: "b1",
  brief_id_human: "br-1",
  status: "posted",
  payload: validPayload,
  decided_at: null,
  decided_by: null,
  decided_notes: null,
};

describe("BriefDetailPage", () => {
  it("renders the page chrome + approval gate when posted", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { data: null, error: null, single: { data: baseRow, error: null } } },
      events: {
        select: {
          data: [{ id: "e1", kind: "created", ref_table: "briefs", ref_id: "b1" }],
          error: null,
        },
      },
    });

    const el = await BriefDetailPage({ params: Promise.resolve({ id: "b1" }) });
    render(el);
    expect(screen.getByText("Austin")).toBeInTheDocument();
    expect(screen.getByText("Posted")).toBeInTheDocument();
    expect(screen.getByTestId("approval-gate")).toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toHaveAttribute("data-count", "1");
    expect(screen.getByText(/test notes/)).toBeInTheDocument();
    expect(screen.getByText(/fast/)).toBeInTheDocument();
  });

  it("renders the decision section for an approved brief", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              ...baseRow,
              status: "approved",
              decided_at: "2026-05-17T10:00:00Z",
              decided_by: "alice",
              decided_notes: "ship",
            },
            error: null,
          },
        },
      },
      events: { select: { data: [], error: null } },
    });
    const el = await BriefDetailPage({ params: Promise.resolve({ id: "b1" }) });
    render(el);
    expect(screen.getByText(/by alice/)).toBeInTheDocument();
    expect(screen.getByText("ship")).toBeInTheDocument();
  });

  it("shows untitled fallback + dashes when payload is malformed", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: {
          data: null,
          error: null,
          single: {
            data: { ...baseRow, payload: { invalid: 1 } },
            error: null,
          },
        },
      },
      events: { select: { data: [], error: null } },
    });
    const el = await BriefDetailPage({ params: Promise.resolve({ id: "b1" }) });
    render(el);
    expect(screen.getByText(/Untitled brief/i)).toBeInTheDocument();
  });

  it("throws when the brief query errors", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: { data: null, error: null, single: { data: null, error: { message: "boom" } } },
      },
      events: { select: { data: [], error: null } },
    });
    await expect(BriefDetailPage({ params: Promise.resolve({ id: "b1" }) })).rejects.toThrow(
      "boom",
    );
  });

  it("calls notFound when brief is missing", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { data: null, error: null, single: { data: null, error: null } } },
      events: { select: { data: [], error: null } },
    });
    await expect(BriefDetailPage({ params: Promise.resolve({ id: "b1" }) })).rejects.toThrow(
      "__NOT_FOUND__",
    );
  });

  it("generateMetadata returns a title with the short id", async () => {
    const m = await generateMetadata({ params: Promise.resolve({ id: "abcd1234-rest" }) });
    expect(m.title).toBe("Brief abcd1234 — VoxHorizon");
  });
});
