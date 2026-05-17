import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

vi.mock("@/components/audit/AttentionCards", () => ({
  AttentionCards: ({ rows }: { rows: unknown[] }) => (
    <div data-testid="attention" data-rows={rows.length} />
  ),
}));
vi.mock("@/components/audit/FormatTabs", () => ({
  FormatTabs: ({ value }: { value: string }) => <div data-testid="format-tabs">{value}</div>,
}));
vi.mock("@/components/audit/FunnelSankey", () => ({
  FunnelSankey: () => <div data-testid="sankey" />,
}));
vi.mock("@/components/audit/PerfTable", () => ({
  PerfTable: ({ rows }: { rows: unknown[] }) => <div data-testid="perf" data-rows={rows.length} />,
}));

import AuditPage from "./page";

function audit_row(over: Record<string, unknown>) {
  return {
    id: "r1",
    client_id: null,
    campaign_id: "c1",
    window_days: 30,
    spend: 100,
    impressions: 1000,
    clicks: 10,
    ctr: 0.01,
    leads_meta: 1,
    leads_ghl: 0,
    cpl_real: 10,
    freq: 1.5,
    verdict: "watch",
    verdict_reason: null,
    pulled_at: "2026-05-17T00:00:00Z",
    ...over,
  };
}

describe("AuditPage", () => {
  it("renders the empty state when no rows + no errors", async () => {
    currentSupabase = mockSupabaseClient({
      campaign_perf_image: { select: { data: [], error: null } },
      campaign_perf_video: { select: { data: [], error: null } },
    });
    const el = await AuditPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByRole("heading", { level: 1, name: /audit/i })).toBeInTheDocument();
    expect(screen.getByText(/no audit data yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("attention")).not.toBeInTheDocument();
  });

  it("renders cards + sankey + table when rows exist", async () => {
    currentSupabase = mockSupabaseClient({
      campaign_perf_image: {
        select: {
          data: [audit_row({ id: "i1" })],
          error: null,
        },
      },
      campaign_perf_video: {
        select: {
          data: [
            audit_row({
              id: "v1",
              hook_rate: 0.2,
              drop_off_3s: 0.5,
              view_rate_avg: 0.4,
              watch_time_p50: 8,
            }),
          ],
          error: null,
        },
      },
    });
    const el = await AuditPage({
      searchParams: Promise.resolve({ format: "combined", window: "30" }),
    });
    render(el);
    expect(screen.getByTestId("attention")).toHaveAttribute("data-rows", "2");
    expect(screen.getByTestId("perf")).toHaveAttribute("data-rows", "2");
    expect(screen.getByTestId("sankey")).toBeInTheDocument();
  });

  it("surfaces errors when the table query fails", async () => {
    currentSupabase = mockSupabaseClient({
      campaign_perf_image: {
        select: { data: null, error: { message: "img-fail" } },
      },
      campaign_perf_video: {
        select: { data: null, error: { message: "vid-fail" } },
      },
    });
    const el = await AuditPage({
      searchParams: Promise.resolve({ format: "combined" }),
    });
    render(el);
    expect(screen.getByRole("alert")).toHaveTextContent(/img-fail.*vid-fail/);
  });

  it("renders only image rows for format=image", async () => {
    currentSupabase = mockSupabaseClient({
      campaign_perf_image: { select: { data: [audit_row({ id: "i1" })], error: null } },
    });
    const el = await AuditPage({
      searchParams: Promise.resolve({ format: "image" }),
    });
    render(el);
    expect(screen.getByTestId("perf")).toHaveAttribute("data-rows", "1");
  });

  it("renders only video rows for format=video", async () => {
    currentSupabase = mockSupabaseClient({
      campaign_perf_video: { select: { data: [audit_row({ id: "v1" })], error: null } },
    });
    const el = await AuditPage({
      searchParams: Promise.resolve({ format: "video" }),
    });
    render(el);
    expect(screen.getByTestId("perf")).toHaveAttribute("data-rows", "1");
  });

  it("handles array-shaped search param values", async () => {
    currentSupabase = mockSupabaseClient({
      campaign_perf_image: { select: { data: [], error: null } },
      campaign_perf_video: { select: { data: [], error: null } },
    });
    const el = await AuditPage({
      searchParams: Promise.resolve({
        format: ["image", "ignored"],
        window: ["7", "ignored"],
      }),
    });
    render(el);
    expect(screen.getByTestId("format-tabs")).toHaveTextContent("image");
  });

  it("renders the window picker links + selected state", async () => {
    currentSupabase = mockSupabaseClient({
      campaign_perf_image: { select: { data: [], error: null } },
      campaign_perf_video: { select: { data: [], error: null } },
    });
    const el = await AuditPage({
      searchParams: Promise.resolve({ window: "7" }),
    });
    render(el);
    const sevenLink = screen.getByRole("link", { name: /^7d$/ });
    expect(sevenLink).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /^30d$/ })).toHaveAttribute("href", "/audit");
  });
});
