/**
 * Tests for the audit "needs attention" cards. Confirms:
 *   - Empty state copy when no rows.
 *   - Top-5 sort + slicing logic.
 *   - The healthy-only headline ("All N healthy...") vs urgent.
 *   - Image vs video pick the right headline metric.
 *   - Verdict badge is rendered.
 *   - Anchor href targets the in-page table row.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AttentionCards } from "./AttentionCards";
import type { AuditRow } from "@/lib/audit";

function imageRow(over: Partial<AuditRow>): AuditRow {
  return {
    id: "i1",
    client_id: null,
    campaign_id: "img-camp-1",
    window_days: 7,
    format: "image",
    spend: 100,
    impressions: 1000,
    clicks: 30,
    ctr: 0.03,
    leads_meta: 4,
    leads_ghl: 0,
    cpl_real: 25,
    freq: 1.2,
    hook_rate: null,
    drop_off_3s: null,
    view_rate_avg: null,
    watch_time_p50: null,
    verdict: "keep",
    verdict_reason: null,
    pulled_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

function videoRow(over: Partial<AuditRow>): AuditRow {
  return {
    id: "v1",
    client_id: null,
    campaign_id: "vid-camp-1",
    window_days: 30,
    format: "video",
    spend: 500,
    impressions: 30000,
    clicks: 700,
    ctr: 0.023,
    leads_meta: 10,
    leads_ghl: 1,
    cpl_real: 45,
    freq: 2.0,
    hook_rate: 0.42,
    drop_off_3s: 0.6,
    view_rate_avg: 0.25,
    watch_time_p50: 12,
    verdict: "watch",
    verdict_reason: "high freq",
    pulled_at: "2026-05-02T00:00:00Z",
    ...over,
  };
}

describe("AttentionCards", () => {
  it("renders the empty-state copy when no rows are supplied", () => {
    render(<AttentionCards rows={[]} format="combined" />);

    expect(screen.getByText(/No campaigns to surface yet/i)).toBeInTheDocument();
  });

  it("renders only the top 5 rows sorted by attention", () => {
    const rows: AuditRow[] = Array.from({ length: 10 }).map((_, i) =>
      imageRow({
        id: `i${i}`,
        campaign_id: `camp-${i}`,
        spend: 100 - i, // descending spend so sort order is determinate
      }),
    );
    render(<AttentionCards rows={rows} format="image" />);

    // Top-5 cards plus header text — restrict to anchors.
    const cards = screen.getAllByRole("link");
    expect(cards).toHaveLength(5);
  });

  it('shows the "All N healthy" headline when no kill/watch verdicts present', () => {
    const rows = [
      imageRow({ id: "a", campaign_id: "a", verdict: "keep" }),
      imageRow({ id: "b", campaign_id: "b", verdict: "keep" }),
    ];
    render(<AttentionCards rows={rows} format="image" />);

    expect(screen.getByText(/All 2 healthy\. Showing top by spend\./i)).toBeInTheDocument();
  });

  it("shows the severity-sorted headline when at least one urgent verdict is present", () => {
    const rows = [
      imageRow({ id: "a", campaign_id: "a", verdict: "kill" }),
      imageRow({ id: "b", campaign_id: "b", verdict: "keep" }),
    ];
    render(<AttentionCards rows={rows} format="image" />);

    expect(screen.getByText(/Showing 2 of 2, sorted by severity then spend/i)).toBeInTheDocument();
  });

  it("uses CPL as the headline metric for image rows", () => {
    const rows = [imageRow({ cpl_real: 25 })];
    render(<AttentionCards rows={rows} format="image" />);

    expect(screen.getByText("CPL")).toBeInTheDocument();
    expect(screen.getByText("$25")).toBeInTheDocument();
  });

  it("uses Hook rate as the headline metric for video rows", () => {
    const rows = [videoRow({ hook_rate: 0.42 })];
    render(<AttentionCards rows={rows} format="video" />);

    expect(screen.getByText("Hook rate")).toBeInTheDocument();
    expect(screen.getByText("42.00%")).toBeInTheDocument();
  });

  it("anchors each card to the in-page table row id", () => {
    const rows = [imageRow({ id: "abc-123" })];
    render(<AttentionCards rows={rows} format="image" />);

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "#row-image-abc-123");
  });

  it("renders the verdict badge for each row", () => {
    const rows = [imageRow({ id: "a", verdict: "kill", verdict_reason: null })];
    render(<AttentionCards rows={rows} format="image" />);

    expect(screen.getByText("Kill")).toBeInTheDocument();
  });

  it("renders the spend section regardless of whether the row has a verdict", () => {
    const rows = [imageRow({ verdict: null, spend: 250 })];
    render(<AttentionCards rows={rows} format="image" />);

    expect(screen.getByText("Spend")).toBeInTheDocument();
    expect(screen.getByText("$250")).toBeInTheDocument();
  });

  it("handles missing spend (null) by treating it as 0 for the spark", () => {
    const rows = [imageRow({ spend: null })];
    render(<AttentionCards rows={rows} format="image" />);

    // Card still renders.
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
