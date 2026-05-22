import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./", import.meta.url)) };

/**
 * Vitest config for the Next.js app.
 *
 * `projects` carves the test suite into two parallel runs that share
 * coverage but pick different environments:
 *
 *  - `node`   — Vitest's default. Runs anything under `lib/**`, which is
 *               server-only / pure-Node code.
 *  - `jsdom`  — Browser-shaped DOM. Required for React Testing Library to
 *               render components, and for jsdom-backed parsing in API
 *               route tests that touch `Request` / `Response`.
 *
 * Coverage uses `all: true` so unimported source files still show up at
 * 0% — that's how the parallel coverage agents will know which files
 * still need tests. The `exclude` list trims pure-type modules, shadcn
 * primitives (vendored, low value to test), and test fixtures.
 *
 * Vitest 4 removed `environmentMatchGlobs`; `projects` is the supported
 * replacement (see https://vitest.dev/guide/projects).
 */
export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./tests/unit/setup.ts"],
    exclude: ["node_modules/**", "tests/e2e/**", ".next/**"],
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "node",
          globals: true,
          environment: "node",
          setupFiles: ["./tests/unit/setup.ts"],
          include: ["lib/**/*.{test,spec}.{ts,tsx}"],
          exclude: ["node_modules/**", "tests/e2e/**", ".next/**"],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "jsdom",
          globals: true,
          environment: "jsdom",
          setupFiles: ["./tests/unit/setup.ts"],
          include: [
            "components/**/*.{test,spec}.{ts,tsx}",
            "hooks/**/*.{test,spec}.{ts,tsx}",
            "app/**/*.{test,spec}.{ts,tsx}",
            "middleware.{test,spec}.{ts,tsx}",
            // Harness self-tests (T.3): exercise the shared API-route test
            // helpers in `tests/unit/helpers/` without colocating a synthetic
            // spec under app/. They invoke real route handlers, so they need
            // the same jsdom-shaped `Request`/`Response` environment.
            "tests/unit/**/*.{test,spec}.{ts,tsx}",
          ],
          exclude: ["node_modules/**", "tests/e2e/**", ".next/**"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      // Note: Vitest 4 removed the `all` option — `include` already
      // covers every matching file, whether or not a test imported it.
      include: [
        "lib/**/*.{ts,tsx}",
        "components/**/*.{ts,tsx}",
        "hooks/**/*.{ts,tsx}",
        "app/**/*.{ts,tsx}",
        "middleware.{ts,tsx}",
      ],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/*.gen.ts",
        "**/*.d.ts",
        "components/ui/**",
        "**/types.ts",
        "**/types/**",
        "**/__mocks__/**",
        "tests/**",
      ],
      // Production coverage gate (enforced in CI via `pnpm test:coverage`).
      // statements/lines/functions sit at 96-98% today, so 90 is a real floor.
      // branches is 88% on LEGACY UI that the P4 rebuild replaces; grinding
      // branch tests into soon-deleted components is wasted effort, so the
      // global branch floor is 88 and RATCHETS to 90 as P4 lands. New rebuild
      // code is held to >=90 branches by the Definition of Done (PR review).
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 88,
      },
    },
  },
});
