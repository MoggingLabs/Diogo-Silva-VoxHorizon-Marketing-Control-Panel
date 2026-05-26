import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

// The manager is a heavy client component with its own tests; stub it here so
// this test asserts only the SSR seeding contract (both formats fetched + the
// active rows handed down).
vi.mock("@/components/launch/LaunchesManager", () => ({
  LaunchesManager: ({
    initialImage,
    initialVideo,
  }: {
    initialImage: { id: string }[];
    initialVideo: { id: string }[];
  }) => (
    <div
      data-testid="launches-manager"
      data-image-count={initialImage.length}
      data-video-count={initialVideo.length}
    />
  ),
}));

import LaunchesIndexPage from "./page";

describe("LaunchesIndexPage", () => {
  it("seeds the manager with active image + video launches", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: {
        select: {
          data: [{ id: "l1", brief_id: "b1", status: "posted", payload: {}, deleted_at: null }],
          error: null,
        },
      },
      video_launch_packages: {
        select: { data: [], error: null },
      },
    });
    const el = await LaunchesIndexPage();
    render(el);
    const manager = screen.getByTestId("launches-manager");
    expect(manager).toHaveAttribute("data-image-count", "1");
    expect(manager).toHaveAttribute("data-video-count", "0");
  });

  it("tolerates empty result sets", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: { select: { data: [], error: null } },
      video_launch_packages: { select: { data: [], error: null } },
    });
    const el = await LaunchesIndexPage();
    render(el);
    const manager = screen.getByTestId("launches-manager");
    expect(manager).toHaveAttribute("data-image-count", "0");
    expect(manager).toHaveAttribute("data-video-count", "0");
  });
});
