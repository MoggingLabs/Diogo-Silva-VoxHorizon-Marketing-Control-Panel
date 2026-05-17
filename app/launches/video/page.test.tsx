import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

import VideoLaunchesIndexPage from "./page";

describe("VideoLaunchesIndexPage", () => {
  it("renders empty state when no launches", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: { select: { data: [], error: null } },
    });
    const el = await VideoLaunchesIndexPage();
    render(el);
    expect(screen.getByText(/No video launches yet/i)).toBeInTheDocument();
  });

  it("renders the alert for query errors", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: { data: null, error: { message: "fail" } },
      },
    });
    const el = await VideoLaunchesIndexPage();
    render(el);
    expect(screen.getByRole("alert")).toHaveTextContent("fail");
  });

  it("renders a row + pill when payload is valid", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: {
          data: [
            {
              id: "vl1",
              brief_id: "b1",
              status: "posted",
              payload: {
                brief_id_human: "vb-1",
                client: { id: "c", slug: "s", name: "Acme" },
                video_creative_ids: [],
                copy_variant_ids: [],
                issues: [],
                validation: { ok: true, via: "preflight" },
              },
              created_at: "2026-05-17T00:00:00Z",
              decided_at: null,
            },
          ],
          error: null,
        },
      },
    });
    const el = await VideoLaunchesIndexPage();
    render(el);
    expect(screen.getByRole("link", { name: /vb-1/ })).toHaveAttribute(
      "href",
      "/launches/video/vl1",
    );
    expect(screen.getByText("Posted")).toBeInTheDocument();
  });

  it("falls back to id slice + raw status for invalid payload/status", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: {
          data: [
            {
              id: "vl-broken",
              brief_id: "b",
              status: "exotic-status",
              payload: { bad: true },
              created_at: "2026-05-17T00:00:00Z",
              decided_at: null,
            },
          ],
          error: null,
        },
      },
    });
    const el = await VideoLaunchesIndexPage();
    render(el);
    // id slice and raw status pill render.
    expect(screen.getByRole("link", { name: /vl-broke/ })).toBeInTheDocument();
    expect(screen.getByText("exotic-status")).toBeInTheDocument();
  });
});
