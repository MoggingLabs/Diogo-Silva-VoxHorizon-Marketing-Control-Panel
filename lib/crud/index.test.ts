/**
 * Smoke test for the `@/lib/crud` barrel: every helper the resource routes
 * (M2+) import from the single module is actually re-exported.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import * as crud from "./index";

describe("lib/crud barrel", () => {
  it("re-exports the list-query helpers", () => {
    expect(typeof crud.parseListQuery).toBe("function");
    expect(typeof crud.applyListQuery).toBe("function");
    expect(typeof crud.paginationMeta).toBe("function");
  });

  it("re-exports the soft-delete helpers", () => {
    expect(typeof crud.softDelete).toBe("function");
    expect(typeof crud.restore).toBe("function");
    expect(typeof crud.hardDelete).toBe("function");
  });

  it("re-exports the event helpers", () => {
    expect(typeof crud.emitEvent).toBe("function");
    expect(typeof crud.emitEvents).toBe("function");
    expect(typeof crud.eventKind).toBe("function");
  });

  it("re-exports the response helpers", () => {
    for (const fn of [
      crud.ok,
      crud.created,
      crud.zodError,
      crud.badJson,
      crud.badRequest,
      crud.notFound,
      crud.conflict,
      crud.serverError,
    ]) {
      expect(typeof fn).toBe("function");
    }
  });
});
