import { describe, expect, it, vi } from "vitest";

import {
  CREATIVES_BUCKET,
  CreativeDecision,
  CreativeStatus,
  DEFAULT_SIGNED_URL_TTL_S,
  DecisionInput,
  IterationAuthor,
  IterationKind,
  Ratio,
  STATUS_LABEL,
  STATUS_PILL,
  allowedDecisions,
  canDecide,
  decisionToStatus,
  getSignedUrl,
} from "./creatives";

describe("creatives enums + decision tables", () => {
  it("CreativeStatus / CreativeDecision / IterationKind / Author / Ratio accept literals", () => {
    expect(CreativeStatus.safeParse("draft").success).toBe(true);
    expect(CreativeStatus.safeParse("posted").success).toBe(false);
    expect(CreativeDecision.safeParse("approve").success).toBe(true);
    expect(IterationKind.safeParse("comment").success).toBe(true);
    expect(IterationAuthor.safeParse("ekko").success).toBe(true);
    expect(Ratio.safeParse("1x1").success).toBe(true);
  });

  it("DecisionInput requires a known decision", () => {
    expect(DecisionInput.safeParse({ decision: "approve" }).success).toBe(true);
    expect(DecisionInput.safeParse({ decision: "approved" }).success).toBe(false);
  });

  it("allowedDecisions only enables decisions from draft", () => {
    expect(allowedDecisions.draft).toContain("approve");
    expect(allowedDecisions.approved).toEqual([]);
  });

  it("canDecide gates terminal states", () => {
    expect(canDecide("draft", "approve")).toBe(true);
    expect(canDecide("draft", "reject")).toBe(true);
    expect(canDecide("approved", "approve")).toBe(false);
    expect(canDecide("live", "reject")).toBe(false);
  });

  it("decisionToStatus maps to the resulting status", () => {
    expect(decisionToStatus("approve")).toBe("approved");
    expect(decisionToStatus("reject")).toBe("rejected");
  });

  it("exposes presentation tables for every status", () => {
    expect(STATUS_LABEL.draft).toBe("Draft");
    expect(STATUS_PILL.live).toMatch(/indigo/);
    expect(CREATIVES_BUCKET).toBe("creatives");
    expect(DEFAULT_SIGNED_URL_TTL_S).toBe(3600);
  });
});

function fakeStorageClient({
  signedUrl,
  error,
}: {
  signedUrl?: string | null;
  error?: { message: string } | null;
}) {
  const createSignedUrl = vi.fn(async () => ({
    data: signedUrl ? { signedUrl } : null,
    error: error ?? null,
  }));
  return {
    storage: {
      from: vi.fn(() => ({ createSignedUrl })),
    },
    _createSignedUrl: createSignedUrl,
  };
}

describe("getSignedUrl", () => {
  it("returns null for a missing path without hitting storage", async () => {
    const client = fakeStorageClient({ signedUrl: "noop" });
    const url = await getSignedUrl(client as never, null);
    expect(url).toBeNull();
    expect(client._createSignedUrl).not.toHaveBeenCalled();
  });

  it("returns the signed URL on success", async () => {
    const client = fakeStorageClient({ signedUrl: "https://signed/p" });
    const url = await getSignedUrl(client as never, "img.png");
    expect(url).toBe("https://signed/p");
    expect(client._createSignedUrl).toHaveBeenCalledWith("img.png", DEFAULT_SIGNED_URL_TTL_S);
  });

  it("returns null + logs when storage reports an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeStorageClient({ signedUrl: null, error: { message: "oops" } });
    const url = await getSignedUrl(client as never, "x.png");
    expect(url).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("oops"));
    warn.mockRestore();
  });

  it("returns null when data has no signedUrl and no error reported", async () => {
    const client = fakeStorageClient({ signedUrl: null });
    expect(await getSignedUrl(client as never, "x.png")).toBeNull();
  });

  it("respects a custom TTL override", async () => {
    const client = fakeStorageClient({ signedUrl: "https://signed/p" });
    await getSignedUrl(client as never, "img.png", 60);
    expect(client._createSignedUrl).toHaveBeenCalledWith("img.png", 60);
  });
});
