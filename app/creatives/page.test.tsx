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

import CreativesIndexPage from "./page";

describe("CreativesIndexPage", () => {
  it("renders the empty state when no creatives exist on either side", async () => {
    currentSupabase = mockSupabaseClient({
      creatives: { select: { data: [], error: null } },
      video_creatives: { select: { data: [], error: null } },
      briefs: { select: { data: [], error: null } },
      video_briefs: { select: { data: [], error: null } },
    });
    const element = await CreativesIndexPage();
    render(element);
    expect(screen.getByTestId("empty")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /browse briefs/i })).toHaveAttribute("href", "/briefs");
  });

  it("surfaces a Supabase error from either side", async () => {
    currentSupabase = mockSupabaseClient({
      creatives: { select: { data: null, error: { message: "no creative table" } } },
      video_creatives: { select: { data: [], error: null } },
      briefs: { select: { data: [], error: null } },
      video_briefs: { select: { data: [], error: null } },
    });
    const element = await CreativesIndexPage();
    render(element);
    expect(screen.getByText(/Failed to load creatives: no creative table/i)).toBeInTheDocument();
  });

  it("groups image and video creatives by brief and links to the right route", async () => {
    currentSupabase = mockSupabaseClient({
      creatives: {
        select: {
          data: [
            { brief_id: "b-img-1", status: "draft", created_at: "2026-05-17T10:00:00Z" },
            { brief_id: "b-img-1", status: "draft", created_at: "2026-05-17T11:00:00Z" },
            { brief_id: "b-img-2", status: "approved", created_at: "2026-05-15T08:00:00Z" },
          ],
          error: null,
        },
      },
      video_creatives: {
        select: {
          data: [{ brief_id: "b-vid-1", status: "captioned", created_at: "2026-05-17T12:00:00Z" }],
          error: null,
        },
      },
      briefs: {
        select: {
          data: [
            {
              id: "b-img-1",
              brief_id_human: "br-img-1",
              status: "approved",
              created_at: "2026-05-16T00:00:00Z",
            },
            {
              id: "b-img-2",
              brief_id_human: "br-img-2",
              status: "approved",
              created_at: "2026-05-15T00:00:00Z",
            },
          ],
          error: null,
        },
      },
      video_briefs: {
        select: {
          data: [
            {
              id: "b-vid-1",
              brief_id_human: "vbr-1",
              status: "approved",
              created_at: "2026-05-17T00:00:00Z",
            },
          ],
          error: null,
        },
      },
    });

    const element = await CreativesIndexPage();
    render(element);

    // All three briefs surface in the table with the correct route shape.
    const imageOne = screen.getByRole("link", { name: "br-img-1" });
    expect(imageOne).toHaveAttribute("href", "/creatives/b-img-1");
    expect(screen.getByRole("link", { name: "br-img-2" })).toHaveAttribute(
      "href",
      "/creatives/b-img-2",
    );
    expect(screen.getByRole("link", { name: "vbr-1" })).toHaveAttribute(
      "href",
      "/creatives/video/b-vid-1",
    );

    // The image side row with two variants reports its count.
    const variantsCells = screen.getAllByRole("cell").filter((c) => c.textContent === "2");
    expect(variantsCells.length).toBeGreaterThanOrEqual(1);
  });

  it("skips creatives whose brief headers cannot be fetched", async () => {
    currentSupabase = mockSupabaseClient({
      creatives: {
        select: {
          data: [{ brief_id: "orphan", status: "draft", created_at: "2026-05-17T10:00:00Z" }],
          error: null,
        },
      },
      video_creatives: { select: { data: [], error: null } },
      briefs: { select: { data: [], error: null } },
      video_briefs: { select: { data: [], error: null } },
    });
    const element = await CreativesIndexPage();
    render(element);
    // Orphan should fall back to the empty state since no brief header matches.
    expect(screen.getByTestId("empty")).toBeInTheDocument();
  });

  it("exposes a focused metadata title", async () => {
    const mod = await import("./page");
    expect(mod.metadata).toEqual({ title: "Creatives — VoxHorizon" });
  });
});
