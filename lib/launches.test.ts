import { describe, expect, it } from "vitest";

import { LaunchInput } from "./launches";

describe("LaunchInput", () => {
  it("accepts the bare brief_id-only shape (launch-from-scratch)", () => {
    const result = LaunchInput.safeParse({
      brief_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.brief_id).toBe("11111111-1111-4111-8111-111111111111");
      expect(result.data.pipeline_id).toBeUndefined();
    }
  });

  it("accepts an optional pipeline_id (PF-F handoff)", () => {
    const result = LaunchInput.safeParse({
      brief_id: "11111111-1111-4111-8111-111111111111",
      pipeline_id: "22222222-2222-4222-9222-222222222222",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pipeline_id).toBe("22222222-2222-4222-9222-222222222222");
    }
  });

  it("rejects a non-uuid pipeline_id", () => {
    const result = LaunchInput.safeParse({
      brief_id: "11111111-1111-4111-8111-111111111111",
      pipeline_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when brief_id is missing", () => {
    const result = LaunchInput.safeParse({
      pipeline_id: "22222222-2222-4222-9222-222222222222",
    });
    expect(result.success).toBe(false);
  });
});
