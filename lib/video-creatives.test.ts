import { describe, expect, it, vi } from "vitest";

import {
  BrollClip,
  CREATIVES_BUCKET,
  DEFAULT_SIGNED_URL_TTL_S,
  ITERATION_AUTHOR_LABEL,
  ITERATION_KIND_LABEL,
  STAGE_ORDER,
  STATUS_LABEL,
  STATUS_PILL,
  VideoCreativeDecision,
  VideoCreativeStatus,
  VideoDecisionInput,
  VideoIterationAuthor,
  VideoIterationKind,
  allowedDecisions,
  canDecide,
  decisionToStatus,
  getSignedUrl,
  readBrollClips,
} from "./video-creatives";

describe("video-creatives enums", () => {
  it("status / decision / iteration enums accept canonical literals", () => {
    expect(VideoCreativeStatus.safeParse("captioned").success).toBe(true);
    expect(VideoCreativeStatus.safeParse("draft").success).toBe(true);
    expect(VideoCreativeDecision.safeParse("approve").success).toBe(true);
    expect(VideoIterationKind.safeParse("rerender").success).toBe(true);
    expect(VideoIterationAuthor.safeParse("user").success).toBe(true);
  });

  it("VideoDecisionInput accepts shape", () => {
    expect(VideoDecisionInput.safeParse({ decision: "reject" }).success).toBe(true);
    expect(VideoDecisionInput.safeParse({ decision: "approved" }).success).toBe(false);
  });
});

describe("state machine", () => {
  it("approve only fires from captioned; reject works from any pipeline stage", () => {
    expect(canDecide("captioned", "approve")).toBe(true);
    expect(canDecide("captioned", "reject")).toBe(true);
    expect(canDecide("draft", "approve")).toBe(false);
    expect(canDecide("draft", "reject")).toBe(true);
    expect(canDecide("approved", "approve")).toBe(false);
    expect(canDecide("script_ready", "reject")).toBe(true);
    expect(allowedDecisions.approved).toEqual([]);
    expect(allowedDecisions.rejected).toEqual([]);
  });

  it("decisionToStatus", () => {
    expect(decisionToStatus("approve")).toBe("approved");
    expect(decisionToStatus("reject")).toBe("rejected");
  });
});

describe("BrollClip + readBrollClips", () => {
  it("BrollClip parses a minimal record", () => {
    expect(
      BrollClip.safeParse({
        segment_idx: 0,
        store_backend: "local",
        clip_id: "clip-1",
        in_s: 0,
        out_s: 5,
        source_url: "src",
      }).success,
    ).toBe(true);
  });

  it("readBrollClips returns [] for null + invalid + valid arrays", () => {
    expect(readBrollClips(null as never)).toEqual([]);
    expect(readBrollClips({ bad: "shape" } as never)).toEqual([]);
    expect(
      readBrollClips([
        {
          segment_idx: 0,
          store_backend: "local",
          clip_id: "c",
          in_s: 0,
          out_s: 1,
          source_url: "u",
        },
      ] as never),
    ).toHaveLength(1);
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
    storage: { from: vi.fn(() => ({ createSignedUrl })) },
    _createSignedUrl: createSignedUrl,
  };
}

describe("getSignedUrl (video)", () => {
  it("returns null when path is missing", async () => {
    const c = fakeStorageClient({ signedUrl: "noop" });
    expect(await getSignedUrl(c as never, null)).toBeNull();
    expect(c._createSignedUrl).not.toHaveBeenCalled();
  });

  it("returns the signed URL on success", async () => {
    const c = fakeStorageClient({ signedUrl: "https://signed" });
    expect(await getSignedUrl(c as never, "v.mp4")).toBe("https://signed");
    expect(c._createSignedUrl).toHaveBeenCalledWith("v.mp4", DEFAULT_SIGNED_URL_TTL_S);
  });

  it("returns null + warns when storage errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = fakeStorageClient({ signedUrl: null, error: { message: "fail" } });
    expect(await getSignedUrl(c as never, "v.mp4")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null when neither data nor error are present", async () => {
    const c = fakeStorageClient({ signedUrl: null });
    expect(await getSignedUrl(c as never, "v.mp4")).toBeNull();
  });

  it("respects a custom TTL", async () => {
    const c = fakeStorageClient({ signedUrl: "https://x" });
    await getSignedUrl(c as never, "v.mp4", 60);
    expect(c._createSignedUrl).toHaveBeenCalledWith("v.mp4", 60);
  });
});

describe("presentation tables", () => {
  it("STATUS_LABEL / STATUS_PILL include every status", () => {
    expect(STATUS_LABEL.draft).toBe("Draft");
    expect(STATUS_PILL.approved).toContain("green");
    expect(STAGE_ORDER).toContain("captioned");
    expect(STAGE_ORDER).not.toContain("approved");
    expect(ITERATION_KIND_LABEL.recaption).toBe("Re-captioned");
    expect(ITERATION_AUTHOR_LABEL.user).toBe("Operator");
    expect(CREATIVES_BUCKET).toBe("creatives");
  });
});
