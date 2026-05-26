import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type CreativeRow } from "@/lib/creatives-rows";

// The page builds unified rows server-side via buildCreativeRows; we mock that
// + the grid client component so the page test stays a thin render check.
const buildSpy = vi.fn();
vi.mock("@/lib/creatives-rows", () => ({
  buildCreativeRows: (...args: unknown[]) => buildSpy(...args),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({}),
}));
vi.mock("@/components/creative/CreativesGrid", () => ({
  CreativesGrid: ({ initialRows }: { initialRows: CreativeRow[] }) => (
    <div data-testid="grid" data-count={initialRows.length} />
  ),
}));

import CreativesIndexPage from "./page";

describe("CreativesIndexPage", () => {
  it("renders the header + grid with the built rows", async () => {
    buildSpy.mockResolvedValueOnce({
      rows: [
        { id: "c1", kind: "image" },
        { id: "v1", kind: "video" },
      ] as CreativeRow[],
      error: null,
    });
    const el = await CreativesIndexPage();
    render(el);
    expect(screen.getByRole("heading", { name: /creatives/i })).toBeInTheDocument();
    expect(screen.getByTestId("grid")).toHaveAttribute("data-count", "2");
  });

  it("surfaces a load error banner", async () => {
    buildSpy.mockResolvedValueOnce({ rows: [], error: "boom" });
    const el = await CreativesIndexPage();
    render(el);
    expect(screen.getByText(/Failed to load creatives: boom/i)).toBeInTheDocument();
  });
});
