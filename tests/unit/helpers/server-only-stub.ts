/**
 * No-op stand-in for the `server-only` package in unit tests.
 *
 * `server-only` exports a module that throws unless resolved under the
 * `react-server` condition. Unit tests import server modules (e.g. `lib/crud`,
 * `lib/clients/integrations`) directly to exercise their logic, so we alias
 * `server-only` to this empty module in `vitest.config.ts`. The real guard
 * still applies during `next build`, which is the binding gate.
 */
export {};
