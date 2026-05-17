import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

vi.mock("@/components/brief/VideoBriefForm", () => ({
  VideoBriefForm: ({ clients }: { clients: { id: string }[] }) => (
    <div data-testid="form" data-client-count={clients.length} />
  ),
}));

import NewVideoBriefPage from "./page";

describe("NewVideoBriefPage", () => {
  it("loads clients and renders the form", async () => {
    currentSupabase = mockSupabaseClient({
      clients: {
        select: {
          data: [
            { id: "c1", name: "Acme", slug: "acme", status: "active" },
            { id: "c2", name: "Beta", slug: "beta", status: "inactive" },
          ],
          error: null,
        },
      },
    });
    const el = await NewVideoBriefPage();
    render(el);
    expect(screen.getByRole("heading", { name: /new video brief/i })).toBeInTheDocument();
    expect(screen.getByTestId("form")).toHaveAttribute("data-client-count", "1");
  });

  it("renders the empty-clients fallback", async () => {
    currentSupabase = mockSupabaseClient({
      clients: { select: { data: [], error: null } },
    });
    const el = await NewVideoBriefPage();
    render(el);
    expect(screen.getByText(/no active clients yet/i)).toBeInTheDocument();
  });

  it("renders an alert when the clients query errors", async () => {
    currentSupabase = mockSupabaseClient({
      clients: { select: { data: null, error: { message: "db down" } } },
    });
    const el = await NewVideoBriefPage();
    render(el);
    expect(screen.getByRole("alert")).toHaveTextContent(/db down/);
  });
});
