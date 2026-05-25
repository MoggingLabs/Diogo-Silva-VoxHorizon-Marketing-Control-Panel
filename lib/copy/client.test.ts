import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { archiveCopy, createCopy, restoreCopy, updateCopy } from "./client";
import { jsonResponse, spyOnFetch, textResponse } from "@/tests/unit/helpers/worker-mock";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.VERCEL_URL;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  vi.restoreAllMocks();
});

describe("createCopy", () => {
  it("POSTs /api/copy with the body", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ variant: { id: "cv1" } }, { status: 201 }));
    await createCopy({ format: "image", creative_id: "cr1", variant_index: 1 });
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe("http://localhost:3000/api/copy");
    expect((call?.[1] as RequestInit | undefined)?.method).toBe("POST");
  });

  it("throws the inline error on a 409 duplicate", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ error: "duplicate_variant" }, { status: 409 }));
    await expect(
      createCopy({ format: "image", creative_id: "cr1", variant_index: 1 }),
    ).rejects.toThrow(/duplicate_variant/);
  });
});

describe("updateCopy", () => {
  it("PATCHes /api/copy/:id", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ variant: { id: "cv1" } }));
    await updateCopy("cv1", { format: "video", headline: "x" });
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe("http://localhost:3000/api/copy/cv1");
    expect((call?.[1] as RequestInit | undefined)?.method).toBe("PATCH");
  });
});

describe("archiveCopy", () => {
  it("DELETEs /api/copy/:id with the format query (image)", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ variant: { id: "cv1" } }));
    await archiveCopy("image", "cv1");
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe("http://localhost:3000/api/copy/cv1?format=image");
    expect((call?.[1] as RequestInit | undefined)?.method).toBe("DELETE");
  });

  it("uses the video format query", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({}));
    await archiveCopy("video", "vv1");
    expect(spy.mock.calls[0]?.[0]).toBe("http://localhost:3000/api/copy/vv1?format=video");
  });

  it("throws on a non-2xx (non-JSON body falls back to status text)", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(textResponse("nope", { status: 500 }));
    await expect(archiveCopy("image", "cv1")).rejects.toThrow(/500/);
  });
});

describe("restoreCopy", () => {
  it("POSTs /api/copy/:id/restore with the format query", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ variant: { id: "cv1" } }));
    await restoreCopy("image", "cv1");
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe("http://localhost:3000/api/copy/cv1/restore?format=image");
    expect((call?.[1] as RequestInit | undefined)?.method).toBe("POST");
  });
});
