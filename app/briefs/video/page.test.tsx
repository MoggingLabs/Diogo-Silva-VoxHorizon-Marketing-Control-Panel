import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

import VideoBriefsIndexPage from "./page";

describe("VideoBriefsIndexPage", () => {
  it("renders the empty state with a link to create one", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { data: [], error: null } },
    });
    const el = await VideoBriefsIndexPage();
    render(el);
    expect(screen.getByRole("link", { name: /create the first one/i })).toHaveAttribute(
      "href",
      "/briefs/video/new",
    );
  });

  it("renders the alert when loading fails", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { data: null, error: { message: "down" } } },
    });
    const el = await VideoBriefsIndexPage();
    render(el);
    expect(screen.getByRole("alert")).toHaveTextContent(/down/);
  });

  it("renders rows with client + duration + status", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: {
        select: {
          data: [
            {
              id: "v1",
              brief_id_human: "vb-1",
              status: "draft",
              target_duration_s: 30,
              created_at: "2026-05-17T00:00:00Z",
              posted_at: null,
              decided_at: null,
              client_id: "c1",
              clients: { slug: "acme", name: "Acme" },
            },
            {
              id: "v2",
              brief_id_human: "vb-2",
              status: "unknown",
              target_duration_s: null,
              created_at: "2026-05-17T00:00:00Z",
              posted_at: null,
              decided_at: null,
              client_id: null,
              clients: [{ slug: "x", name: "Beta" }],
            },
          ],
          error: null,
        },
      },
    });
    const el = await VideoBriefsIndexPage();
    render(el);
    expect(screen.getByRole("link", { name: /vb-1/ })).toBeInTheDocument();
    expect(screen.getByText("Acme · 30s · created 5/17/2026")).toBeInTheDocument();
    expect(screen.getByText("draft")).toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });
});
