/**
 * Unit tests for the shared CRUD response/error helpers (E1.1 / #583).
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

import {
  badJson,
  badRequest,
  conflict,
  created,
  notFound,
  ok,
  serverError,
  zodError,
} from "./responses";

describe("crud/responses", () => {
  it("ok() -> 200 with the body", async () => {
    const res = ok({ hello: "world" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
  });

  it("created() -> 201 with the body", async () => {
    const res = created({ id: "x" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "x" });
  });

  it("zodError() -> 400 with validation_failed + issues", async () => {
    const parsed = z.object({ name: z.string() }).safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const res = zodError(parsed.error);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("badJson() -> 400 Invalid JSON body", async () => {
    const res = badJson();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  it("badRequest() -> 400 with the message", async () => {
    const res = badRequest("nothing to update");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("nothing to update");
  });

  it("notFound() -> 404 (default + custom message)", async () => {
    const def = notFound();
    expect(def.status).toBe(404);
    expect((await def.json()).error).toBe("not_found");
    const custom = notFound("brief missing");
    expect((await custom.json()).error).toBe("brief missing");
  });

  it("conflict() -> 409 merging detail keys", async () => {
    const res = conflict("invalid_transition", { from: "approved", to: "draft" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid_transition", from: "approved", to: "draft" });
  });

  it("conflict() -> 409 with no detail", async () => {
    const res = conflict("already_archived");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_archived" });
  });

  it("serverError() handles a postgrest error object", async () => {
    const res = serverError({ message: "boom" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
  });

  it("serverError() handles a string", async () => {
    const res = serverError("down");
    expect((await res.json()).error).toBe("down");
  });

  it("serverError() falls back to a generic message", async () => {
    expect((await serverError(null).json()).error).toBe("internal_error");
    expect((await serverError(undefined).json()).error).toBe("internal_error");
    expect((await serverError({}).json()).error).toBe("internal_error");
  });
});
