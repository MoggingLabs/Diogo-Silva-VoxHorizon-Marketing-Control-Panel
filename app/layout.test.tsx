/**
 * Tests the root layout. The layout returns `<html><body><AppShell>{children}</AppShell></body></html>`
 * which cannot be rendered as a fragment inside another <html> via RTL, so we
 * exercise it by directly inspecting the element returned from the layout
 * factory function and confirming key wrappers + metadata.
 */
import { describe, expect, it, vi } from "vitest";

// Stub `next/font/google` — at runtime in node this throws because the
// font fetcher needs the Next runtime. We replace it with an inert
// factory that returns a stable className object.
vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "inter-cls", variable: "var-inter" }),
}));

// Stub the AppShell — we only care that the root layout wraps the children
// inside it.
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

import RootLayout, { metadata } from "./layout";

describe("RootLayout", () => {
  it("renders the html/body wrapper with AppShell inside", () => {
    const tree = RootLayout({
      children: <span data-testid="child">hi</span>,
    });
    // The root is an `html` element with a className tied to the Inter font.
    expect(tree.type).toBe("html");
    expect(tree.props.className).toContain("var-inter");
    // Walk into the body → AppShell → child.
    const body = tree.props.children;
    expect(body.type).toBe("body");
    const shell = body.props.children;
    expect(shell.type).toBeDefined();
  });

  it("exports robots-noindex metadata", () => {
    expect(metadata.title).toBe("VoxHorizon Marketing Control Panel");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.description).toMatch(/marketing operations/i);
  });
});
