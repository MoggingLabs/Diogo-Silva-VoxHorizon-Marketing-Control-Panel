/**
 * Tests for the ThemeToggle header control.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const setTheme = vi.fn();
let theme = "dark";
let resolvedTheme = "dark";
vi.mock("@/components/ThemeProvider", () => ({
  useTheme: () => ({ theme, resolvedTheme, setTheme, toggleTheme: vi.fn() }),
}));

import { ThemeToggle } from "./ThemeToggle";

afterEach(() => {
  vi.clearAllMocks();
  theme = "dark";
  resolvedTheme = "dark";
});

describe("ThemeToggle", () => {
  it("renders a theme trigger button", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: /change theme/i })).toBeInTheDocument();
  });

  it("opens the menu and sets a theme on select", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole("button", { name: /change theme/i }));
    await user.click(await screen.findByRole("menuitem", { name: /light/i }));
    expect(setTheme).toHaveBeenCalledWith("light");
  });
});
