/**
 * Tests for the audit-page format tab strip.
 *
 * Same shape as `<FormatToggle />` but with a different default ("combined")
 * and different pathname ("/audit"). We mock the next/navigation hooks and
 * assert on `router.replace(...)`.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const searchParamsMock = { toString: vi.fn(() => "") };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParamsMock,
}));

import { FormatTabs } from "./FormatTabs";

beforeEach(() => {
  replace.mockReset();
  searchParamsMock.toString = vi.fn(() => "");
});

describe("FormatTabs", () => {
  it("renders three tabs with the current value selected", () => {
    render(<FormatTabs value="combined" />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs.find((t) => t.textContent === "All formats")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("navigates to `/audit?format=image` when picking Image", async () => {
    render(<FormatTabs value="combined" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Image" }));

    expect(replace).toHaveBeenCalledWith("/audit?format=image", {
      scroll: false,
    });
  });

  it("navigates to `/audit` when picking the default (combined)", async () => {
    render(<FormatTabs value="image" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "All formats" }));

    expect(replace).toHaveBeenCalledWith("/audit", { scroll: false });
  });

  it("does not navigate when clicking the already-active tab", async () => {
    render(<FormatTabs value="image" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Image" }));

    expect(replace).not.toHaveBeenCalled();
  });

  it("preserves unrelated query params on change", async () => {
    searchParamsMock.toString = vi.fn(() => "window=7");
    render(<FormatTabs value="combined" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Video" }));

    const [href] = replace.mock.calls[0]!;
    expect(href).toContain("window=7");
    expect(href).toContain("format=video");
  });
});
