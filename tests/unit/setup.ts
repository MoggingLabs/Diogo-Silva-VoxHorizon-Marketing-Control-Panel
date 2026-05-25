/**
 * Global test setup, loaded by Vitest before every spec file via
 * `setupFiles` in `vitest.config.ts`.
 *
 * - Wires `@testing-library/jest-dom`'s matchers (`toBeInTheDocument`,
 *   `toHaveClass`, ...) into Vitest's `expect`.
 * - Tears down the DOM between tests so component renders don't leak state
 *   into the next spec.
 */
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
});

// jsdom lacks ResizeObserver, which cmdk (the command palette) and some Radix
// primitives reach for. Provide a no-op so those components render in tests.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom doesn't implement scrollIntoView, which Radix/cmdk call on
// active-item changes. Stub it so keyboard navigation in menus/lists works.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

// jsdom doesn't implement the Pointer Capture API, which Radix Select relies
// on to open its listbox under userEvent. Stub the trio so Select dropdowns
// open in tests.
if (typeof Element !== "undefined" && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
}
