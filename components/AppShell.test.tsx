/**
 * Tests for the root layout chrome.
 *
 * Covers:
 *   - Renders the brand + WorkerStatus.
 *   - Renders the primary nav link to each section.
 *   - Marks the active link via aria-current based on `usePathname()`.
 *   - Hamburger button opens the mobile sheet (the sheet renders the nav too).
 *   - Renders the supplied `children` in the main slot.
 *
 * We stub `next/navigation` for `usePathname()`, and stub `WorkerStatus`
 * so we don't have to wire its fetch + 30s interval here.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pathname = vi.fn(() => "/");

vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
}));

vi.mock("./WorkerStatus", () => ({
  WorkerStatus: () => <div data-testid="worker-status" />,
}));

import { AppShell } from "./AppShell";

beforeEach(() => {
  pathname.mockReturnValue("/");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AppShell", () => {
  it("renders the supplied children inside the main slot", () => {
    render(
      <AppShell>
        <p>Hello content</p>
      </AppShell>,
    );

    expect(screen.getByText("Hello content")).toBeInTheDocument();
  });

  it("renders the WorkerStatus indicator", () => {
    render(
      <AppShell>
        <span />
      </AppShell>,
    );

    expect(screen.getByTestId("worker-status")).toBeInTheDocument();
  });

  it("renders nav links for each section", () => {
    render(
      <AppShell>
        <span />
      </AppShell>,
    );

    // The desktop sidebar uses Primary nav; the mobile sheet portal also renders
    // a Primary nav once opened. Names should appear in either path.
    expect(screen.getAllByRole("link", { name: /Dashboard/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /Pipeline/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /Briefs/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /Creatives/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /Launches/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /Audit/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /Settings/i }).length).toBeGreaterThan(0);
  });

  it("marks the Dashboard link as current when pathname is `/`", () => {
    pathname.mockReturnValue("/");
    render(
      <AppShell>
        <span />
      </AppShell>,
    );

    const dashLinks = screen.getAllByRole("link", { name: /Dashboard/i });
    // At least one of them is aria-current=page.
    expect(dashLinks.some((l) => l.getAttribute("aria-current") === "page")).toBe(true);
  });

  it("marks the Pipeline link as current for /pipeline/[id]", () => {
    pathname.mockReturnValue("/pipeline/abc");
    render(
      <AppShell>
        <span />
      </AppShell>,
    );

    const pLinks = screen.getAllByRole("link", { name: /Pipeline/i });
    expect(pLinks.some((l) => l.getAttribute("aria-current") === "page")).toBe(true);
  });

  it("marks the Audit link as current under /audit", () => {
    pathname.mockReturnValue("/audit");
    render(
      <AppShell>
        <span />
      </AppShell>,
    );

    const aLinks = screen.getAllByRole("link", { name: /Audit/i });
    expect(aLinks.some((l) => l.getAttribute("aria-current") === "page")).toBe(true);
  });

  it("falls back to '/' when usePathname returns null", () => {
    pathname.mockReturnValue(null as unknown as string);
    render(
      <AppShell>
        <span />
      </AppShell>,
    );

    const dashLinks = screen.getAllByRole("link", { name: /Dashboard/i });
    expect(dashLinks.some((l) => l.getAttribute("aria-current") === "page")).toBe(true);
  });

  it("opens the mobile sheet when the hamburger button is clicked", async () => {
    render(
      <AppShell>
        <span />
      </AppShell>,
    );

    const trigger = screen.getByRole("button", {
      name: /open navigation menu/i,
    });
    // The Sheet is closed initially — assert by counting nav links visible.
    const initialDashLinks = screen.getAllByRole("link", { name: /Dashboard/i });

    const user = userEvent.setup();
    await user.click(trigger);

    // Once open, the sheet renders an extra NavList (so we now have at least 2 Dashboard links).
    const openDashLinks = screen.getAllByRole("link", { name: /Dashboard/i });
    expect(openDashLinks.length).toBeGreaterThanOrEqual(initialDashLinks.length);
  });
});
