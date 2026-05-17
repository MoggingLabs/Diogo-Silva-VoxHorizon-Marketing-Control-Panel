import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Vitest config. Scoped tightly to co-located unit tests under `lib/`
 * (and similar) so Playwright `tests/e2e/**` specs are never picked up.
 * Keep this list focused — broaden it deliberately as new unit-test
 * surfaces appear.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    include: ["lib/**/*.{test,spec}.{ts,tsx}", "components/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules/**", "tests/e2e/**", ".next/**"],
    environment: "node",
  },
});
