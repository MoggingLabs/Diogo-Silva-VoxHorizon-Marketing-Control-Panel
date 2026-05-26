import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentAdmin: SupabaseClientMock;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentAdmin,
}));

vi.mock("@/lib/video-creatives", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/video-creatives")>("@/lib/video-creatives");
  return { ...actual, getSignedUrl: vi.fn(async () => "https://signed/c.mp4") };
});

vi.mock("@/components/creative/VideoCreativeManage", () => ({
  VideoCreativeManage: ({
    creative,
    signedUrl,
  }: {
    creative: { id: string };
    signedUrl: string;
  }) => <div data-testid="manage" data-id={creative.id} data-url={signedUrl} />,
}));

const notFoundSpy = vi.fn(() => {
  throw new Error("__NOT_FOUND__");
});
vi.mock("next/navigation", () => ({ notFound: () => notFoundSpy() }));

import ManageVideoCreativePage, { generateMetadata } from "./page";

const ID = "22222222-2222-4222-8222-222222222222";

describe("ManageVideoCreativePage", () => {
  it("renders the manage component with the loaded creative", async () => {
    currentAdmin = mockClient({
      video_creatives: {
        select: {
          single: { data: { id: ID, brief_id: "vb1", captioned_path: "c.mp4" }, error: null },
        },
      },
      video_briefs: {
        select: { single: { data: { id: "vb1", brief_id_human: "vbr-1" }, error: null } },
      },
      video_copy_variants: { select: { data: [], error: null } },
      qa_result: { select: { data: [], error: null } },
      spec_check: { select: { data: [], error: null } },
      compliance_finding: { select: { data: [], error: null } },
      creative_stage_state: { select: { data: [], error: null } },
    });
    const el = await ManageVideoCreativePage({ params: Promise.resolve({ id: ID }) });
    render(el);
    expect(screen.getByTestId("manage")).toHaveAttribute("data-id", ID);
    expect(screen.getByTestId("manage")).toHaveAttribute("data-url", "https://signed/c.mp4");
  });

  it("calls notFound when the creative is missing", async () => {
    currentAdmin = mockClient({
      video_creatives: { select: { single: { data: null, error: null } } },
    });
    await expect(ManageVideoCreativePage({ params: Promise.resolve({ id: ID }) })).rejects.toThrow(
      "__NOT_FOUND__",
    );
  });

  it("throws when the read errors", async () => {
    currentAdmin = mockClient({
      video_creatives: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    await expect(ManageVideoCreativePage({ params: Promise.resolve({ id: ID }) })).rejects.toThrow(
      "boom",
    );
  });

  it("generateMetadata returns a truncated title", async () => {
    const m = await generateMetadata({ params: Promise.resolve({ id: ID }) });
    expect(m.title).toMatch(/Manage video creative 22222222/);
  });
});
