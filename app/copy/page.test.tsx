import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

vi.mock("@/components/copy/CopyManager", () => ({
  CopyManager: ({
    format,
    creativeId,
    variants,
  }: {
    format: string;
    creativeId: string;
    variants: unknown[];
  }) => (
    <div
      data-testid="copy-manager"
      data-format={format}
      data-creative={creativeId}
      data-count={variants.length}
    />
  ),
}));

const notFoundSpy = vi.fn(() => {
  throw new Error("__NOT_FOUND__");
});
vi.mock("next/navigation", () => ({
  notFound: () => notFoundSpy(),
}));

import CopyPage from "./page";

describe("CopyPage", () => {
  it("shows a missing-creative message when creative_id is absent", async () => {
    currentSupabase = mockSupabaseClient({});
    const el = await CopyPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByText(/missing/i)).toBeInTheDocument();
  });

  it("renders the manager with the image creative's variants + a back-link to the brief", async () => {
    currentSupabase = mockSupabaseClient({
      creatives: {
        select: {
          data: null,
          error: null,
          single: { data: { id: "cr1", brief_id: "b1" }, error: null },
        },
      },
      copy_variants: {
        select: { data: [{ id: "cv1", variant_index: 1, platform: "meta" }], error: null },
      },
    });
    const el = await CopyPage({
      searchParams: Promise.resolve({ creative_id: "cr1", format: "image" }),
    });
    render(el);
    const manager = screen.getByTestId("copy-manager");
    expect(manager).toHaveAttribute("data-format", "image");
    expect(manager).toHaveAttribute("data-count", "1");
    expect(screen.getByRole("link", { name: "Brief" })).toHaveAttribute("href", "/briefs/b1");
  });

  it("reads the video creative table + links to the video brief for format=video", async () => {
    currentSupabase = mockSupabaseClient({
      video_creatives: {
        select: {
          data: null,
          error: null,
          single: { data: { id: "vc1", brief_id: "vb1" }, error: null },
        },
      },
      video_copy_variants: { select: { data: [], error: null } },
    });
    const el = await CopyPage({
      searchParams: Promise.resolve({ creative_id: "vc1", format: "video" }),
    });
    render(el);
    expect(screen.getByTestId("copy-manager")).toHaveAttribute("data-format", "video");
    expect(screen.getByRole("link", { name: "Brief" })).toHaveAttribute(
      "href",
      "/briefs/video/vb1",
    );
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("video_creatives");
  });

  it("calls notFound when the creative is missing", async () => {
    currentSupabase = mockSupabaseClient({
      creatives: { select: { data: null, error: null, single: { data: null, error: null } } },
    });
    await expect(
      CopyPage({ searchParams: Promise.resolve({ creative_id: "nope", format: "image" }) }),
    ).rejects.toThrow("__NOT_FOUND__");
  });
});
