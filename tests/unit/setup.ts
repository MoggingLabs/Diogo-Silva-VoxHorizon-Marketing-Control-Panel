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
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
