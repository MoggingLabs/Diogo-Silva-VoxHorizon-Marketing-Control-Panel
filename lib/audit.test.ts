import { describe, expect, it } from "vitest";

import {
  AUDIT_FORMAT_VALUES,
  AUDIT_WINDOW_VALUES,
  DEFAULT_AUDIT_FORMAT,
  DEFAULT_AUDIT_WINDOW,
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  GRACE_PERIOD_DAYS,
  HIGH_DROP_OFF_3S,
  HIGH_FREQUENCY,
  KILL_CPL_MULTIPLIER,
  KILL_SPEND_WITHOUT_LEADS,
  LOW_CTR,
  LOW_HOOK_RATE,
  LOW_WATCH_TIME_P50_S,
  STRONG_CTR,
  VERDICT_SEVERITY,
  VERDICT_VALUES,
  aggregateFunnel,
  compareByAttention,
  formatCurrency,
  formatDecimal,
  formatNumber,
  formatPercent,
  formatSeconds,
  imageRowToAuditRow,
  parseAuditFormat,
  parseAuditWindow,
  severityFor,
  totalLeads,
  videoRowToAuditRow,
  zeroFunnelTotals,
  type AuditRow,
} from "./audit";

describe("audit constants", () => {
  it("exposes the expected verdict + format + window tuples", () => {
    expect(VERDICT_VALUES).toEqual(["kill", "watch", "keep"]);
    expect(AUDIT_FORMAT_VALUES).toEqual(["combined", "image", "video"]);
    expect(AUDIT_WINDOW_VALUES).toEqual([1, 7, 30]);
    expect(DEFAULT_AUDIT_FORMAT).toBe("combined");
    expect(DEFAULT_AUDIT_WINDOW).toBe(30);
  });

  it("exports threshold + severity tables", () => {
    expect(GRACE_PERIOD_DAYS).toBe(2);
    expect(KILL_SPEND_WITHOUT_LEADS).toBe(75);
    expect(KILL_CPL_MULTIPLIER).toBeCloseTo(1.5);
    expect(HIGH_FREQUENCY).toBeCloseTo(3.0);
    expect(LOW_CTR).toBeCloseTo(0.01);
    expect(STRONG_CTR).toBeCloseTo(0.02);
    expect(LOW_HOOK_RATE).toBeCloseTo(0.2);
    expect(HIGH_DROP_OFF_3S).toBeCloseTo(0.8);
    expect(LOW_WATCH_TIME_P50_S).toBe(5);
    expect(VERDICT_SEVERITY).toEqual({ kill: 2, watch: 1, keep: 0 });
  });

  it("exposes funnel stage labels and an empty totals object", () => {
    expect(FUNNEL_STAGES).toContain("impressions");
    expect(FUNNEL_STAGE_LABELS.impressions).toBe("Impressions");
    expect(zeroFunnelTotals()).toEqual({
      impressions: 0,
      clicks: 0,
      leads: 0,
      booked: 0,
      showed: 0,
      sold: 0,
    });
  });
});

describe("parseAuditFormat / parseAuditWindow", () => {
  it.each([
    ["image", "image"],
    ["video", "video"],
    ["combined", "combined"],
    ["bogus", "combined"],
    [undefined, "combined"],
    [null, "combined"],
  ] as const)("parseAuditFormat(%p) = %p", (input, expected) => {
    expect(parseAuditFormat(input)).toBe(expected);
  });

  it.each([
    ["1", 1],
    ["7", 7],
    ["30", 30],
    ["100", 30],
    ["abc", 30],
    [undefined, 30],
    [null, 30],
  ] as const)("parseAuditWindow(%p) = %p", (input, expected) => {
    expect(parseAuditWindow(input)).toBe(expected);
  });
});

describe("severityFor", () => {
  it("returns the severity number, with -1 for null verdicts", () => {
    expect(severityFor("kill")).toBe(2);
    expect(severityFor("watch")).toBe(1);
    expect(severityFor("keep")).toBe(0);
    expect(severityFor(null)).toBe(-1);
  });
});

const baseRow = {
  client_id: "c1",
  campaign_id: "camp1",
  window_days: 7,
  spend: 100,
  impressions: 1000,
  clicks: 10,
  ctr: 0.01,
  leads_meta: 1,
  leads_ghl: 2,
  cpl_real: 25,
  freq: 1.5,
  verdict: "kill" as const,
  verdict_reason: "low",
  pulled_at: "2026-05-17T00:00:00Z",
};

describe("imageRowToAuditRow / videoRowToAuditRow", () => {
  it("maps an image row, leaving video-only fields null", () => {
    const r = { id: "i1", ...baseRow };
    const audit = imageRowToAuditRow(r as never);
    expect(audit.format).toBe("image");
    expect(audit.hook_rate).toBeNull();
    expect(audit.drop_off_3s).toBeNull();
    expect(audit.view_rate_avg).toBeNull();
    expect(audit.watch_time_p50).toBeNull();
    expect(audit.spend).toBe(100);
  });

  it("maps a video row preserving the video-only fields", () => {
    const r = {
      id: "v1",
      ...baseRow,
      hook_rate: 0.3,
      drop_off_3s: 0.5,
      view_rate_avg: 0.4,
      watch_time_p50: 12,
    };
    const audit = videoRowToAuditRow(r as never);
    expect(audit.format).toBe("video");
    expect(audit.hook_rate).toBeCloseTo(0.3);
    expect(audit.drop_off_3s).toBeCloseTo(0.5);
    expect(audit.view_rate_avg).toBeCloseTo(0.4);
    expect(audit.watch_time_p50).toBe(12);
  });
});

describe("totalLeads", () => {
  it("sums both lead columns, treating nulls as zero", () => {
    expect(totalLeads({ leads_meta: 4, leads_ghl: 6 })).toBe(10);
    expect(totalLeads({ leads_meta: null, leads_ghl: 3 })).toBe(3);
    expect(totalLeads({ leads_meta: 2, leads_ghl: null })).toBe(2);
    expect(totalLeads({ leads_meta: null, leads_ghl: null })).toBe(0);
  });
});

function row(overrides: Partial<AuditRow>): AuditRow {
  return {
    id: overrides.id ?? "r",
    client_id: null,
    campaign_id: "c",
    window_days: 7,
    format: "image",
    spend: null,
    impressions: null,
    clicks: null,
    ctr: null,
    leads_meta: null,
    leads_ghl: null,
    cpl_real: null,
    freq: null,
    hook_rate: null,
    drop_off_3s: null,
    view_rate_avg: null,
    watch_time_p50: null,
    verdict: null,
    verdict_reason: null,
    pulled_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

describe("compareByAttention", () => {
  it("severity descending wins over spend", () => {
    const a = row({ id: "a", verdict: "kill", spend: 10 });
    const b = row({ id: "b", verdict: "keep", spend: 1000 });
    expect(compareByAttention(a, b)).toBeLessThan(0);
  });

  it("falls back to spend when severities tie", () => {
    const a = row({ id: "a", verdict: "watch", spend: 5 });
    const b = row({ id: "b", verdict: "watch", spend: 50 });
    expect(compareByAttention(a, b)).toBeGreaterThan(0);
  });

  it("falls back to pulled_at when severity + spend tie", () => {
    const a = row({ id: "a", verdict: "keep", spend: 1, pulled_at: "2026-05-01T00:00:00Z" });
    const b = row({ id: "b", verdict: "keep", spend: 1, pulled_at: "2026-05-02T00:00:00Z" });
    expect(compareByAttention(a, b)).toBeGreaterThan(0); // b is newer
    expect(compareByAttention(a, a)).toBe(0);
  });
});

describe("formatters", () => {
  it("formatCurrency renders dashes for nullish values", () => {
    expect(formatCurrency(null)).toBe("—");
    expect(formatCurrency(undefined)).toBe("—");
    expect(formatCurrency(0)).toBe("$0");
    expect(formatCurrency(1234.5)).toMatch(/\$1,234\.5/);
  });

  it("formatPercent multiplies by 100", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatPercent(0.125)).toBe("12.50%");
  });

  it("formatNumber localizes ints", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
    expect(formatNumber(1234)).toBe("1,234");
  });

  it("formatDecimal respects digits", () => {
    expect(formatDecimal(null)).toBe("—");
    expect(formatDecimal(undefined)).toBe("—");
    expect(formatDecimal(1.23456)).toBe("1.2");
    expect(formatDecimal(1.23456, 3)).toBe("1.235");
  });

  it("formatSeconds adds a trailing s", () => {
    expect(formatSeconds(null)).toBe("—");
    expect(formatSeconds(undefined)).toBe("—");
    expect(formatSeconds(12)).toBe("12.0s");
  });
});

describe("aggregateFunnel", () => {
  it("sums impressions / clicks / leads across rows", () => {
    const rows = [
      row({ impressions: 100, clicks: 5, leads_meta: 1, leads_ghl: 0 }),
      row({ impressions: 200, clicks: 10, leads_meta: 2, leads_ghl: 1 }),
      row({}),
    ];
    expect(aggregateFunnel(rows)).toEqual({
      impressions: 300,
      clicks: 15,
      leads: 4,
      booked: 0,
      showed: 0,
      sold: 0,
    });
  });

  it("returns the zero totals when given no rows", () => {
    expect(aggregateFunnel([])).toEqual(zeroFunnelTotals());
  });
});
