import { describe, expect, it } from "vitest";

import {
  BriefPayload,
  BriefStatus,
  CreateBriefInput,
  Decision,
  DecisionInput,
  ServiceType,
  TargetingSchema,
  UpdateBriefInput,
  allowedTransitions,
  canTransition,
  readBriefPayload,
  transitionEventKind,
} from "./briefs";

describe("BriefStatus / ServiceType / Decision enums", () => {
  it("accepts the canonical literals", () => {
    expect(BriefStatus.safeParse("draft").success).toBe(true);
    expect(BriefStatus.safeParse("bogus").success).toBe(false);
    expect(ServiceType.safeParse("roofing").success).toBe(true);
    expect(ServiceType.safeParse("bogus").success).toBe(false);
    expect(Decision.safeParse("approved").success).toBe(true);
    expect(Decision.safeParse("draft").success).toBe(false);
  });
});

describe("TargetingSchema", () => {
  it("accepts a minimal targeting block", () => {
    expect(TargetingSchema.safeParse({}).success).toBe(true);
    expect(
      TargetingSchema.safeParse({ radius_km: 25, zips: ["12345"], age_min: 21, age_max: 65 })
        .success,
    ).toBe(true);
  });

  it("rejects when age_min > age_max", () => {
    const r = TargetingSchema.safeParse({ age_min: 50, age_max: 20 });
    expect(r.success).toBe(false);
  });

  it("rejects oversized arrays / out-of-range radius", () => {
    const longZips = Array.from({ length: 201 }, (_, i) => String(10000 + i));
    expect(TargetingSchema.safeParse({ zips: longZips }).success).toBe(false);
    expect(TargetingSchema.safeParse({ radius_km: 1000 }).success).toBe(false);
  });
});

describe("BriefPayload", () => {
  const valid = {
    service: "roofing" as const,
    budget: 1000,
    market: "Austin",
  };

  it("accepts the minimal payload", () => {
    expect(BriefPayload.safeParse(valid).success).toBe(true);
  });

  it("rejects budget exceeding the cap", () => {
    expect(BriefPayload.safeParse({ ...valid, budget: 100001 }).success).toBe(false);
  });

  it("defaults creative_plan.image_count to 3", () => {
    const parsed = BriefPayload.safeParse({ ...valid, creative_plan: {} });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.creative_plan?.image_count).toBe(3);
    }
  });

  it("rejects a non-url landing page", () => {
    expect(BriefPayload.safeParse({ ...valid, landing_page_url: "not a url" }).success).toBe(false);
  });
});

describe("CreateBriefInput", () => {
  it("requires a uuid client_id + payload", () => {
    expect(
      CreateBriefInput.safeParse({
        client_id: "11111111-1111-4111-8111-111111111111",
        payload: { service: "roofing", budget: 100, market: "Austin" },
      }).success,
    ).toBe(true);
    expect(CreateBriefInput.safeParse({ payload: {} }).success).toBe(false);
  });
});

describe("UpdateBriefInput", () => {
  it("accepts a payload-only or status-only patch", () => {
    expect(UpdateBriefInput.safeParse({ status: "posted" }).success).toBe(true);
    expect(
      UpdateBriefInput.safeParse({
        payload: { service: "roofing", budget: 1, market: "Austin" },
      }).success,
    ).toBe(true);
  });

  it("rejects an empty patch", () => {
    expect(UpdateBriefInput.safeParse({}).success).toBe(false);
  });
});

describe("DecisionInput", () => {
  it("makes notes optional for approved", () => {
    expect(DecisionInput.safeParse({ decision: "approved" }).success).toBe(true);
  });

  it("requires non-empty notes for approved_with_changes / rejected", () => {
    expect(DecisionInput.safeParse({ decision: "rejected" }).success).toBe(false);
    expect(DecisionInput.safeParse({ decision: "rejected", notes: "   " }).success).toBe(false);
    expect(
      DecisionInput.safeParse({ decision: "approved_with_changes", notes: "  reword" }).success,
    ).toBe(true);
  });
});

describe("canTransition / transitionEventKind", () => {
  it("matches the allowed-transitions table", () => {
    expect(canTransition("draft", "posted")).toBe(true);
    expect(canTransition("posted", "approved")).toBe(true);
    expect(canTransition("approved", "rejected")).toBe(false);
    expect(canTransition("rejected", "draft")).toBe(true);
    // no-op patches are explicitly allowed
    expect(canTransition("draft", "draft")).toBe(true);
  });

  it("emits a stable kind name", () => {
    expect(transitionEventKind("draft", "posted")).toBe("brief_draft_to_posted");
  });

  it("returns false when the from-state has no transitions", () => {
    expect(canTransition("approved", "draft")).toBe(false);
    expect(allowedTransitions.approved).toEqual([]);
  });

  it("returns false for an unknown source status (defensive guard)", () => {
    expect(canTransition("bogus" as never, "draft" as never)).toBe(false);
  });
});

describe("readBriefPayload", () => {
  it("returns the typed payload for valid rows", () => {
    const result = readBriefPayload({
      payload: { service: "roofing", budget: 100, market: "Austin" } as never,
    });
    expect(result?.service).toBe("roofing");
  });

  it("returns null when the payload is malformed", () => {
    expect(readBriefPayload({ payload: { service: "bogus" } as never })).toBeNull();
    expect(readBriefPayload({ payload: null as never })).toBeNull();
  });
});
