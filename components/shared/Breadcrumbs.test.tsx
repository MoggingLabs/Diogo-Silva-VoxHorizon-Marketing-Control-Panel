/**
 * Tests for Breadcrumbs + the useBreadcrumbs derivation.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const pathname = vi.fn(() => "/");
vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
}));

import { Breadcrumbs, useBreadcrumbs } from "./Breadcrumbs";

afterEach(() => {
  vi.clearAllMocks();
  pathname.mockReturnValue("/");
});

describe("useBreadcrumbs", () => {
  it("returns no crumbs at the root", () => {
    expect(useBreadcrumbs("/")).toEqual([]);
  });

  it("labels known segments and links all but the last", () => {
    const crumbs = useBreadcrumbs("/clients/new");
    expect(crumbs).toEqual([
      { label: "Clients", href: "/clients" },
      { label: "New", href: undefined },
    ]);
  });

  it("keeps id-like segments verbatim and title-cases unknown slugs", () => {
    const crumbs = useBreadcrumbs("/briefs/123/edit-draft");
    expect(crumbs[0]).toEqual({ label: "Briefs", href: "/briefs" });
    expect(crumbs[1]).toEqual({ label: "123", href: "/briefs/123" });
    expect(crumbs[2]).toEqual({ label: "Edit Draft", href: undefined });
  });
});

describe("Breadcrumbs", () => {
  it("renders nothing at the root", () => {
    pathname.mockReturnValue("/");
    const { container } = render(<Breadcrumbs />);
    expect(container.querySelector("nav")).toBeNull();
  });

  it("renders a trail with a home link and the current page", () => {
    pathname.mockReturnValue("/clients/new");
    render(<Breadcrumbs />);
    expect(screen.getByRole("navigation", { name: /breadcrumb/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clients" })).toBeInTheDocument();
    const current = screen.getByText("New");
    expect(current).toHaveAttribute("aria-current", "page");
  });

  it("honours an explicit items override", () => {
    pathname.mockReturnValue("/anything");
    render(<Breadcrumbs items={[{ label: "Custom", href: undefined }]} />);
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });
});
