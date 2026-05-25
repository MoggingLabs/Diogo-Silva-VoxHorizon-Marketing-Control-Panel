import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

// Stub the (client) list so we can assert on the props the server page derives
// without pulling Radix / router into the server-component render.
vi.mock("@/components/briefs/BriefsListClient", () => ({
  BriefsListClient: ({
    rows,
    archived,
  }: {
    rows: Array<{ id: string; format: string; clientName: string | null }>;
    archived: boolean;
  }) => (
    <div data-testid="list" data-archived={String(archived)} data-count={rows.length}>
      {rows.map((r) => (
        <span key={r.id} data-format={r.format} data-client={r.clientName ?? ""}>
          {r.id}
        </span>
      ))}
    </div>
  ),
}));

import BriefsListPage from "./page";

function imageBrief(over: Record<string, unknown>) {
  return {
    id: "i1",
    brief_id_human: "img-1",
    client_id: "c1",
    status: "draft",
    created_at: "2026-05-20T00:00:00Z",
    payload: { service: "roofing", budget: 100, market: "Austin" },
    deleted_at: null,
    ...over,
  };
}

function videoBrief(over: Record<string, unknown>) {
  return {
    id: "v1",
    brief_id_human: "vid-1",
    client_id: "c1",
    status: "posted",
    created_at: "2026-05-21T00:00:00Z",
    dimensions: "9x16",
    target_duration_s: 30,
    deleted_at: null,
    ...over,
  };
}

const noParams = Promise.resolve({});

describe("BriefsListPage (unified)", () => {
  it("merges image + video rows and resolves client names", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { data: [imageBrief({})], error: null } },
      video_briefs: { select: { data: [videoBrief({})], error: null } },
      clients: { select: { data: [{ id: "c1", name: "Acme Co" }], error: null } },
    });
    const el = await BriefsListPage({ searchParams: noParams });
    render(el);
    const list = screen.getByTestId("list");
    expect(list).toHaveAttribute("data-count", "2");
    expect(list).toHaveAttribute("data-archived", "false");
    // Both formats present, client name joined.
    expect(screen.getByText("i1")).toHaveAttribute("data-client", "Acme Co");
    expect(screen.getByText("v1")).toHaveAttribute("data-format", "video");
  });

  it("passes archived=true when ?archived=1", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { data: [], error: null } },
      video_briefs: { select: { data: [], error: null } },
      clients: { select: { data: [], error: null } },
    });
    const el = await BriefsListPage({ searchParams: Promise.resolve({ archived: "1" }) });
    render(el);
    expect(screen.getByTestId("list")).toHaveAttribute("data-archived", "true");
  });

  it("renders the error banner when the briefs query fails", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { data: null, error: { message: "db down" } } },
      video_briefs: { select: { data: [], error: null } },
      clients: { select: { data: [], error: null } },
    });
    const el = await BriefsListPage({ searchParams: noParams });
    render(el);
    expect(screen.getByText(/Failed to load briefs: db down/i)).toBeInTheDocument();
  });
});
