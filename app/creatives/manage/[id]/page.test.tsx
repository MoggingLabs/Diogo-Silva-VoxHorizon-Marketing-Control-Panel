import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentAdmin: SupabaseClientMock;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentAdmin,
}));

vi.mock("@/lib/creatives", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creatives")>("@/lib/creatives");
  return { ...actual, getSignedUrl: vi.fn(async () => "https://signed/p.png") };
});

vi.mock("@/components/creative/CreativeManage", () => ({
  CreativeManage: ({ creative, signedUrl }: { creative: { id: string }; signedUrl: string }) => (
    <div data-testid="manage" data-id={creative.id} data-url={signedUrl} />
  ),
}));

const notFoundSpy = vi.fn(() => {
  throw new Error("__NOT_FOUND__");
});
vi.mock("next/navigation", () => ({ notFound: () => notFoundSpy() }));

import ManageCreativePage, { generateMetadata } from "./page";

const ID = "11111111-1111-4111-8111-111111111111";

describe("ManageCreativePage (image)", () => {
  it("renders the manage component with the loaded creative", async () => {
    currentAdmin = mockClient({
      creatives: { select: { single: { data: { id: ID, brief_id: "b1" }, error: null } } },
      briefs: { select: { single: { data: { id: "b1", brief_id_human: "br-1" }, error: null } } },
      copy_variants: { select: { data: [], error: null } },
      qa_result: { select: { data: [], error: null } },
      spec_check: { select: { data: [], error: null } },
      compliance_finding: { select: { data: [], error: null } },
      creative_stage_state: { select: { data: [], error: null } },
    });
    const el = await ManageCreativePage({ params: Promise.resolve({ id: ID }) });
    render(el);
    expect(screen.getByTestId("manage")).toHaveAttribute("data-id", ID);
  });

  it("calls notFound when the creative is missing", async () => {
    currentAdmin = mockClient({
      creatives: { select: { single: { data: null, error: null } } },
    });
    await expect(ManageCreativePage({ params: Promise.resolve({ id: ID }) })).rejects.toThrow(
      "__NOT_FOUND__",
    );
  });

  it("throws when the read errors", async () => {
    currentAdmin = mockClient({
      creatives: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    await expect(ManageCreativePage({ params: Promise.resolve({ id: ID }) })).rejects.toThrow(
      "boom",
    );
  });

  it("generateMetadata returns a truncated title", async () => {
    const m = await generateMetadata({ params: Promise.resolve({ id: ID }) });
    expect(m.title).toMatch(/Manage creative 11111111/);
  });
});
