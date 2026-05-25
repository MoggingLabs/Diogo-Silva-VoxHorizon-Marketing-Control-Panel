/**
 * Tests for the ThemeProvider + useTheme: it applies the `.dark` class,
 * persists the chosen mode to localStorage, resolves `system`, toggles
 * through the cycle, and returns a safe fallback outside a provider.
 */
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEY, ThemeProvider, themeBootstrapScript, useTheme } from "./ThemeProvider";

function setMatchMedia(prefersDark: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: prefersDark,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }),
  });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  setMatchMedia(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

function Probe() {
  const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setTheme("light")}>set-light</button>
      <button onClick={toggleTheme}>toggle</button>
    </div>
  );
}

describe("ThemeProvider", () => {
  it("defaults to dark and applies the dark class", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("adopts a persisted choice on mount and removes the dark class for light", () => {
    localStorage.setItem(STORAGE_KEY, "light");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme")).toHaveTextContent("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("persists the chosen theme to localStorage", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await user.click(screen.getByText("set-light"));
    expect(localStorage.getItem(STORAGE_KEY)).toBe("light");
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
  });

  it("resolves system mode against prefers-color-scheme", () => {
    setMatchMedia(true);
    localStorage.setItem(STORAGE_KEY, "system");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
  });

  it("cycles light -> dark -> system on toggle", async () => {
    const user = userEvent.setup();
    localStorage.setItem(STORAGE_KEY, "light");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme")).toHaveTextContent("light");
    await user.click(screen.getByText("toggle"));
    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    await user.click(screen.getByText("toggle"));
    expect(screen.getByTestId("theme")).toHaveTextContent("system");
  });

  it("returns a safe inert fallback outside a provider", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(result.current.resolvedTheme).toBe("dark");
    // calling the inert setters must not throw
    act(() => {
      result.current.setTheme("light");
      result.current.toggleTheme();
    });
  });

  it("exports a bootstrap script string that references the storage key", () => {
    expect(themeBootstrapScript).toContain(STORAGE_KEY);
    expect(themeBootstrapScript).toContain("classList");
  });
});
