import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

vi.mock("@/components/EmptyState", () => ({
  EmptyState: ({ title, action }: { title: string; action: { label: string; href: string } }) => (
    <div data-testid="empty">
      {title} <a href={action.href}>{action.label}</a>
    </div>
  ),
}));

import BriefsListPage from "./page";

function brief(over: Record<string, unknown>) {
  return {
    id: "b1",
    brief_id_human: "br-1",
    status: "draft",
    created_at: "2026-05-17T00:00:00Z",
    payload: { service: "roofing", budget: 100, market: "Austin" },
    ...over,
  };
}

describe("BriefsListPage", () => {
  it("renders the empty state when no briefs", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { data: [], error: null } },
    });
    const element = await BriefsListPage();
    render(element);
    expect(screen.getByTestId("empty")).toBeInTheDocument();
  });

  it("renders the alert when the query errors", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { data: null, error: { message: "db down" } } },
    });
    const element = await BriefsListPage();
    render(element);
    expect(screen.getByText(/Failed to load briefs: db down/i)).toBeInTheDocument();
  });

  it("groups briefs by status into sections", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: {
          data: [
            brief({ id: "1", status: "draft", brief_id_human: "br-draft" }),
            brief({ id: "2", status: "posted", brief_id_human: "br-posted" }),
            brief({ id: "3", status: "approved", brief_id_human: "br-appr" }),
            brief({
              id: "4",
              status: "approved_with_changes",
              brief_id_human: "br-appr-c",
            }),
            brief({ id: "5", status: "rejected", brief_id_human: "br-rej" }),
          ],
          error: null,
        },
      },
    });
    const element = await BriefsListPage();
    render(element);
    // Each status section heading is rendered.
    expect(screen.getByRole("heading", { name: /^Draft$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Posted$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Approved$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /br-draft/ })).toHaveAttribute("href", "/briefs/1");
  });

  it("renders dashes when payload fields are missing", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: {
          data: [brief({ id: "no-payload", payload: null })],
          error: null,
        },
      },
    });
    const element = await BriefsListPage();
    render(element);
    // Multiple dash placeholders are rendered for missing fields.
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });
});
