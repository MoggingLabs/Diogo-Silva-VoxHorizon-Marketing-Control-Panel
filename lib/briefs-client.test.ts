import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { archiveBrief, restoreBrief, updateImageBrief, updateVideoBrief } from "./briefs-client";
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

describe("archiveBrief", () => {
  it("DELETEs the image brief route", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ brief: { id: "b1" } }));
    await archiveBrief("image", "b1");
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe("http://localhost:3000/api/briefs/b1");
    expect((call?.[1] as RequestInit | undefined)?.method).toBe("DELETE");
  });

  it("DELETEs the video brief route for video format", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({}));
    await archiveBrief("video", "v1");
    expect(spy.mock.calls[0]?.[0]).toBe("http://localhost:3000/api/briefs/video/v1");
  });

  it("throws with the inline error on a non-2xx (409 already archived)", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ error: "already_archived" }, { status: 409 }));
    await expect(archiveBrief("image", "b1")).rejects.toThrow(/already_archived/);
  });
});

describe("restoreBrief", () => {
  it("POSTs the restore route (image)", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ brief: { id: "b1" } }));
    await restoreBrief("image", "b1");
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe("http://localhost:3000/api/briefs/b1/restore");
    expect((call?.[1] as RequestInit | undefined)?.method).toBe("POST");
  });

  it("POSTs the video restore route", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({}));
    await restoreBrief("video", "v1");
    expect(spy.mock.calls[0]?.[0]).toBe("http://localhost:3000/api/briefs/video/v1/restore");
  });

  it("falls back to status text when the error body is non-JSON", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(textResponse("boom", { status: 500 }));
    await expect(restoreBrief("image", "b1")).rejects.toThrow(/500/);
  });
});

describe("updateImageBrief", () => {
  it("PATCHes the image route with the body", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ brief: { id: "b1" } }));
    await updateImageBrief("b1", { status: "posted" });
    const call = spy.mock.calls[0];
    expect(call?.[0]).toBe("http://localhost:3000/api/briefs/b1");
    expect((call?.[1] as RequestInit | undefined)?.method).toBe("PATCH");
  });

  it("throws the inline error on a 409 invalid transition", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ error: "invalid_transition" }, { status: 409 }));
    await expect(updateImageBrief("b1", { status: "approved" })).rejects.toThrow(
      /invalid_transition/,
    );
  });
});

describe("updateVideoBrief", () => {
  it("PATCHes the video route with the body", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ id: "v1" }));
    await updateVideoBrief("v1", { voice_id: "x" });
    expect(spy.mock.calls[0]?.[0]).toBe("http://localhost:3000/api/briefs/video/v1");
  });

  it("uses NEXT_PUBLIC_APP_URL when set", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ id: "v1" }));
    await updateVideoBrief("v1", {});
    expect(spy.mock.calls[0]?.[0]).toBe("https://app.example.com/api/briefs/video/v1");
  });

  it("uses the VERCEL_URL fallback when NEXT_PUBLIC_APP_URL is unset", async () => {
    process.env.VERCEL_URL = "preview.vercel.app";
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ id: "v1" }));
    await updateVideoBrief("v1", {});
    expect(spy.mock.calls[0]?.[0]).toBe("https://preview.vercel.app/api/briefs/video/v1");
  });
});

describe("error envelope parsing", () => {
  it("prefers the JSON error field over the raw body", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ error: "explicit message" }, { status: 400 }));
    await expect(archiveBrief("image", "b1")).rejects.toThrow(/explicit message/);
  });

  it("falls back to the raw text when the error body is not JSON", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(textResponse("totally not json", { status: 502 }));
    await expect(archiveBrief("image", "b1")).rejects.toThrow(/totally not json/);
  });

  it("tolerates a non-JSON 2xx body (resolves without throwing)", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(textResponse("", { status: 200 }));
    await expect(restoreBrief("image", "b1")).resolves.toBeUndefined();
  });
});
