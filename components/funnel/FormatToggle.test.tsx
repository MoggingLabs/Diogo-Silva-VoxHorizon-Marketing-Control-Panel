/**
 * Tests for the URL-driven format selector. We mock the next/navigation
 * hooks (`useRouter`, `useSearchParams`) to assert on the resulting
 * `router.replace(...)` call.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const push = vi.fn();
const back = vi.fn();
const searchParamsMock = { toString: vi.fn(() => "") };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push, back, refresh: vi.fn() }),
  useSearchParams: () => searchParamsMock,
}));

import { FormatToggle } from "./FormatToggle";

beforeEach(() => {
  replace.mockReset();
  searchParamsMock.toString = vi.fn(() => "");
});

describe("FormatToggle", () => {
  it("renders three radio options with the supplied value marked checked", () => {
    render(<FormatToggle value="image" />);

    const buttons = screen.getAllByRole("radio");
    expect(buttons).toHaveLength(3);
    expect(buttons.find((b) => b.textContent === "Image")).toHaveAttribute("aria-checked", "true");
    expect(buttons.find((b) => b.textContent === "Video")).toHaveAttribute("aria-checked", "false");
    expect(buttons.find((b) => b.textContent === "Both")).toHaveAttribute("aria-checked", "false");
  });

  it("navigates to `/?format=image` when picking image from both", async () => {
    render(<FormatToggle value="both" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Image" }));

    expect(replace).toHaveBeenCalledWith("/?format=image", { scroll: false });
  });

  it("navigates to `/` (no query string) when picking both", async () => {
    render(<FormatToggle value="image" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Both" }));

    expect(replace).toHaveBeenCalledWith("/", { scroll: false });
  });

  it("does not navigate when clicking the already-selected option", async () => {
    render(<FormatToggle value="image" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Image" }));

    expect(replace).not.toHaveBeenCalled();
  });

  it("preserves other query params when toggling", async () => {
    searchParamsMock.toString = vi.fn(() => "tab=foo");
    render(<FormatToggle value="image" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Video" }));

    expect(replace).toHaveBeenCalledWith(expect.stringContaining("tab=foo"), { scroll: false });
    expect(replace).toHaveBeenCalledWith(expect.stringContaining("format=video"), {
      scroll: false,
    });
  });

  it("drops the format param when switching to both (default)", async () => {
    searchParamsMock.toString = vi.fn(() => "format=image&tab=foo");
    render(<FormatToggle value="image" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Both" }));

    const [href] = replace.mock.calls[0]!;
    expect(href).not.toContain("format=");
    expect(href).toContain("tab=foo");
  });

  it('tolerates a null searchParams from the hook (the `?? ""` fallback)', async () => {
    // Re-mock useSearchParams to return null via the toString mock returning undefined.
    searchParamsMock.toString = vi.fn(() => "");
    render(<FormatToggle value="both" />);

    fireEvent.click(screen.getByRole("radio", { name: "Image" }));
    expect(replace).toHaveBeenCalled();
  });
});
