import { describe, expect, it, vi } from "vitest";

import { OverrideInput, makeOverrideClient, overrideClient } from "./overrides";

describe("OverrideInput", () => {
  it("accepts a clean override", () => {
    const r = OverrideInput.safeParse({
      table_name: "briefs",
      row_id: "uuid-1",
      field_name: "status",
      corrected_value: "approved",
    });
    expect(r.success).toBe(true);
  });

  it("rejects bad ident characters in table_name / field_name", () => {
    expect(
      OverrideInput.safeParse({
        table_name: "bri efs",
        row_id: "r",
        field_name: "status",
        corrected_value: 1,
      }).success,
    ).toBe(false);
    expect(
      OverrideInput.safeParse({
        table_name: "briefs",
        row_id: "r",
        field_name: "stat us",
        corrected_value: 1,
      }).success,
    ).toBe(false);
  });

  it("enforces length caps", () => {
    expect(
      OverrideInput.safeParse({
        table_name: "a".repeat(65),
        row_id: "r",
        field_name: "x",
        corrected_value: 1,
      }).success,
    ).toBe(false);
  });
});

describe("makeOverrideClient", () => {
  it("returns ok on a 200", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const client = makeOverrideClient(fetchImpl as unknown as typeof fetch);
    const r = await client.set({
      table_name: "briefs",
      row_id: "r",
      field_name: "f",
      corrected_value: 1,
    });
    expect(r).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/overrides",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns the response body on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 }));
    const client = makeOverrideClient(fetchImpl as unknown as typeof fetch);
    const r = await client.set({
      table_name: "briefs",
      row_id: "r",
      field_name: "f",
      corrected_value: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad");
  });

  it("falls back to HTTP status string when body read fails", async () => {
    const failingResponse = {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: vi.fn(() => Promise.reject(new Error("body-fail"))),
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => failingResponse);
    const client = makeOverrideClient(fetchImpl as unknown as typeof fetch);
    const r = await client.set({
      table_name: "briefs",
      row_id: "r",
      field_name: "f",
      corrected_value: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // statusText becomes the fallback message.
      expect(r.error).toBe("Internal Server Error");
    }
  });

  it("falls back to a generic HTTP message when both body and statusText are empty", async () => {
    const failingResponse = {
      ok: false,
      status: 500,
      statusText: "",
      text: vi.fn(() => Promise.resolve("")),
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => failingResponse);
    const client = makeOverrideClient(fetchImpl as unknown as typeof fetch);
    const r = await client.set({
      table_name: "briefs",
      row_id: "r",
      field_name: "f",
      corrected_value: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("HTTP 500");
  });

  it("surfaces network errors as a friendly message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const client = makeOverrideClient(fetchImpl as unknown as typeof fetch);
    const r = await client.set({
      table_name: "briefs",
      row_id: "r",
      field_name: "f",
      corrected_value: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("offline");
  });

  it("falls back to 'network error' for non-Error throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw "string-thrown";
    });
    const client = makeOverrideClient(fetchImpl as unknown as typeof fetch);
    const r = await client.set({
      table_name: "briefs",
      row_id: "r",
      field_name: "f",
      corrected_value: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("network error");
  });

  it("exposes a default global client (uses globalThis.fetch)", () => {
    expect(typeof overrideClient.set).toBe("function");
  });
});
