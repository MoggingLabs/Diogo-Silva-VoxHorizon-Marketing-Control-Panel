import { describe, expect, it } from "vitest";

import {
  classify,
  realCpl,
  summarizeKpis,
  DEFAULT_THRESHOLDS,
  VERDICT_LABEL,
  VERDICT_TONE,
  type PerfRow,
} from "./thresholds";

const row = (over: Partial<PerfRow> = {}): PerfRow => ({
  campaign_id: "c1",
  spend: 100,
  leads_ghl: 2,
  leads_meta: 3,
  ctr: 0.02,
  freq: 1.5,
  cpl_real: null,
  ...over,
});

describe("realCpl (GHL truth)", () => {
  it("computes spend ÷ GHL leads", () => {
    expect(realCpl(200, 4)).toBe(50);
  });
  it("never uses Meta leads — null when GHL is zero even if Meta has leads", () => {
    expect(realCpl(200, 0)).toBeNull();
  });
  it("is null with no spend", () => {
    expect(realCpl(0, 5)).toBeNull();
    expect(realCpl(null, 5)).toBeNull();
  });
  it("is null with null leads", () => {
    expect(realCpl(200, null)).toBeNull();
  });
});

describe("classify", () => {
  it("keeps a healthy row (CPL under target, low freq)", () => {
    expect(classify(row({ spend: 100, leads_ghl: 2 }))).toBe("keep"); // CPL 50 < 100
  });

  it("kills a row that spent past the floor with zero GHL leads", () => {
    expect(classify(row({ spend: 200, leads_ghl: 0 }))).toBe("kill");
  });

  it("watches a row under the kill floor with no leads (no CPL signal)", () => {
    expect(classify(row({ spend: 50, leads_ghl: 0 }))).toBe("watch");
  });

  it("kills a row whose CPL is beyond the kill band", () => {
    // target 100, killMultiplier 1.5 → kill above 150. spend 320 / 2 = 160.
    expect(classify(row({ spend: 320, leads_ghl: 2 }))).toBe("kill");
  });

  it("watches a row in the watch band", () => {
    // watch above 125. spend 260 / 2 = 130.
    expect(classify(row({ spend: 260, leads_ghl: 2 }))).toBe("watch");
  });

  it("downgrades a keep to watch on frequency fatigue", () => {
    expect(classify(row({ spend: 100, leads_ghl: 2, freq: 4 }))).toBe("watch");
  });

  it("respects a custom CPL target", () => {
    // target 50 → kill above 75. spend 200 / 2 = 100.
    expect(
      classify(row({ spend: 200, leads_ghl: 2 }), { ...DEFAULT_THRESHOLDS, cplTarget: 50 }),
    ).toBe("kill");
  });
});

describe("summarizeKpis", () => {
  it("rolls spend/leads up and blends GHL-truth CPL", () => {
    const k = summarizeKpis([
      row({ spend: 100, leads_ghl: 2, leads_meta: 4 }),
      row({ campaign_id: "c2", spend: 100, leads_ghl: 2, leads_meta: 2 }),
    ]);
    expect(k.spend).toBe(200);
    expect(k.leadsGhl).toBe(4);
    expect(k.leadsMeta).toBe(6);
    expect(k.blendedCpl).toBe(50);
    expect(k.leadGap).toBe(2);
    expect(k.campaigns).toBe(2);
  });

  it("handles nulls as zero and a null blended CPL", () => {
    const k = summarizeKpis([row({ spend: null, leads_ghl: null, leads_meta: null })]);
    expect(k.spend).toBe(0);
    expect(k.blendedCpl).toBeNull();
  });

  it("is empty for no rows", () => {
    const k = summarizeKpis([]);
    expect(k.campaigns).toBe(0);
    expect(k.blendedCpl).toBeNull();
  });
});

describe("verdict display maps", () => {
  it("has a label + tone for every verdict", () => {
    for (const v of ["kill", "watch", "keep"] as const) {
      expect(VERDICT_LABEL[v]).toBeTruthy();
      expect(VERDICT_TONE[v]).toBeTruthy();
    }
  });
});
