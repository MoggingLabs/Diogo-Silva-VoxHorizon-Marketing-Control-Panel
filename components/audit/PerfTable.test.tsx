/**
 * Tests for the sortable performance table.
 *
 * Covers:
 *   - Empty-state copy.
 *   - Format-specific column visibility (video-only columns hidden in image mode).
 *   - Default sort direction (spend desc).
 *   - Header click toggles sort dir; clicking a different header switches sort key
 *     and chooses sensible default direction (asc for text, desc for numeric).
 *   - Verdict severity sort.
 *   - aria-sort attribute reflects state.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { PerfTable } from "./PerfTable";
import type { AuditRow } from "@/lib/audit";

function row(over: Partial<AuditRow>): AuditRow {
  return {
    id: "x",
    client_id: null,
    campaign_id: "camp",
    window_days: 7,
    format: "image",
    spend: 100,
    impressions: 1000,
    clicks: 30,
    ctr: 0.03,
    leads_meta: 2,
    leads_ghl: 0,
    cpl_real: 50,
    freq: 1.5,
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

describe("PerfTable", () => {
  it("renders the empty-state copy when no rows", () => {
    render(<PerfTable rows={[]} format="combined" />);

    // M8 routed the empty case through the shared <EmptyState /> primitive so
    // the audit list reads the same as every other empty list in the app; the
    // title is the durable assertion.
    expect(screen.getByText(/No performance rows match this view/i)).toBeInTheDocument();
  });

  it("renders one row per AuditRow with all image columns", () => {
    const rows = [
      row({ id: "a", campaign_id: "alpha", spend: 100 }),
      row({ id: "b", campaign_id: "bravo", spend: 50 }),
    ];
    render(<PerfTable rows={rows} format="image" />);

    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("bravo")).toBeInTheDocument();
    // Image format hides video-only columns
    expect(screen.queryByText("Hook")).not.toBeInTheDocument();
    expect(screen.queryByText("Drop-off")).not.toBeInTheDocument();
  });

  it("renders video columns for video format", () => {
    render(<PerfTable rows={[row({ format: "video" })]} format="video" />);

    expect(screen.getByText("Hook")).toBeInTheDocument();
    expect(screen.getByText("Drop-off")).toBeInTheDocument();
    expect(screen.getByText("p50")).toBeInTheDocument();
  });

  it("shows the Format column in combined mode", () => {
    render(<PerfTable rows={[row({})]} format="combined" />);

    // 'Format' is the header
    expect(screen.getAllByText("Format").length).toBeGreaterThan(0);
  });

  it("default sort is by spend descending", () => {
    const rows = [
      row({ id: "low", campaign_id: "low", spend: 10 }),
      row({ id: "high", campaign_id: "high", spend: 200 }),
      row({ id: "mid", campaign_id: "mid", spend: 100 }),
    ];
    render(<PerfTable rows={rows} format="image" />);

    const tbody = document.querySelector("tbody")!;
    const tr = tbody.querySelectorAll("tr");
    // First row should be "high" (spend 200)
    expect(within(tr[0] as HTMLElement).getByText("high")).toBeInTheDocument();
    expect(within(tr[1] as HTMLElement).getByText("mid")).toBeInTheDocument();
    expect(within(tr[2] as HTMLElement).getByText("low")).toBeInTheDocument();
  });

  it("toggles sort direction when the active header is clicked again", async () => {
    const rows = [
      row({ id: "a", campaign_id: "a", spend: 50 }),
      row({ id: "b", campaign_id: "b", spend: 100 }),
    ];
    render(<PerfTable rows={rows} format="image" />);

    const user = userEvent.setup();
    // Click "Spend" header to flip from desc to asc.
    const spendHeader = screen.getByRole("button", { name: /Spend/ });
    await user.click(spendHeader);

    const tbody = document.querySelector("tbody")!;
    const tr = tbody.querySelectorAll("tr");
    expect(within(tr[0] as HTMLElement).getByText("a")).toBeInTheDocument();
    expect(within(tr[1] as HTMLElement).getByText("b")).toBeInTheDocument();
  });

  it("switches sort key when a different header is clicked, defaults to desc for numerics", async () => {
    const rows = [
      row({ id: "a", campaign_id: "a", spend: 10, ctr: 0.05 }),
      row({ id: "b", campaign_id: "b", spend: 200, ctr: 0.01 }),
    ];
    render(<PerfTable rows={rows} format="image" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /CTR/ }));

    const tbody = document.querySelector("tbody")!;
    const tr = tbody.querySelectorAll("tr");
    // CTR sorted desc → 5% before 1%
    expect(within(tr[0] as HTMLElement).getByText("a")).toBeInTheDocument();
  });

  it("switches sort to ASC by default when clicking text columns (Campaign)", async () => {
    const rows = [
      row({ id: "b", campaign_id: "bravo", spend: 100 }),
      row({ id: "a", campaign_id: "alpha", spend: 200 }),
    ];
    render(<PerfTable rows={rows} format="image" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Campaign/ }));

    const tbody = document.querySelector("tbody")!;
    const tr = tbody.querySelectorAll("tr");
    expect(within(tr[0] as HTMLElement).getByText("alpha")).toBeInTheDocument();
    expect(within(tr[1] as HTMLElement).getByText("bravo")).toBeInTheDocument();
  });

  it("sets aria-sort=descending on the active column header by default", () => {
    render(<PerfTable rows={[row({})]} format="image" />);

    const spendCol = screen.getByText("Spend").closest("th") as HTMLElement;
    expect(spendCol).toHaveAttribute("aria-sort", "descending");
  });

  it("sets aria-sort=ascending after toggling", async () => {
    render(<PerfTable rows={[row({})]} format="image" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Spend/ }));

    const spendCol = screen.getByText("Spend").closest("th") as HTMLElement;
    expect(spendCol).toHaveAttribute("aria-sort", "ascending");
  });

  it("sorts by verdict severity (kill → watch → keep) when descending", async () => {
    const rows = [
      row({ id: "a", campaign_id: "a", verdict: "keep" }),
      row({ id: "b", campaign_id: "b", verdict: "kill" }),
      row({ id: "c", campaign_id: "c", verdict: "watch" }),
    ];
    render(<PerfTable rows={rows} format="image" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Verdict/ }));

    const tbody = document.querySelector("tbody")!;
    const tr = tbody.querySelectorAll("tr");
    expect(within(tr[0] as HTMLElement).getByText("b")).toBeInTheDocument(); // kill
    expect(within(tr[1] as HTMLElement).getByText("c")).toBeInTheDocument(); // watch
    expect(within(tr[2] as HTMLElement).getByText("a")).toBeInTheDocument(); // keep
  });

  it("renders rows with the correct DOM id for anchor navigation", () => {
    render(<PerfTable rows={[row({ id: "row-99" })]} format="image" />);

    expect(document.getElementById("row-image-row-99")).not.toBeNull();
  });

  it("sorts by hook_rate when clicked (video column)", async () => {
    const rows = [
      row({ id: "a", campaign_id: "a", format: "video", hook_rate: 0.1 }),
      row({ id: "b", campaign_id: "b", format: "video", hook_rate: 0.5 }),
    ];
    render(<PerfTable rows={rows} format="video" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Hook/ }));

    const tbody = document.querySelector("tbody")!;
    const tr = tbody.querySelectorAll("tr");
    expect(within(tr[0] as HTMLElement).getByText("b")).toBeInTheDocument();
  });

  it("sorts by drop-off rate", async () => {
    const rows = [
      row({ id: "a", campaign_id: "a", format: "video", drop_off_3s: 0.5 }),
      row({ id: "b", campaign_id: "b", format: "video", drop_off_3s: 0.1 }),
    ];
    render(<PerfTable rows={rows} format="video" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Drop-off/ }));

    const tbody = document.querySelector("tbody")!;
    const tr = tbody.querySelectorAll("tr");
    expect(within(tr[0] as HTMLElement).getByText("a")).toBeInTheDocument();
  });

  it("sorts by watch time p50", async () => {
    const rows = [
      row({ id: "a", campaign_id: "a", format: "video", watch_time_p50: 5 }),
      row({ id: "b", campaign_id: "b", format: "video", watch_time_p50: 15 }),
    ];
    render(<PerfTable rows={rows} format="video" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^p50/ }));

    const tbody = document.querySelector("tbody")!;
    const tr = tbody.querySelectorAll("tr");
    expect(within(tr[0] as HTMLElement).getByText("b")).toBeInTheDocument();
  });

  it("sorts by freq and leads", async () => {
    const rows = [
      row({ id: "a", campaign_id: "a", freq: 1.5, leads_meta: 2 }),
      row({ id: "b", campaign_id: "b", freq: 3.0, leads_meta: 10 }),
    ];
    render(<PerfTable rows={rows} format="image" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Freq/ }));
    const tbody = document.querySelector("tbody")!;
    let tr = tbody.querySelectorAll("tr");
    expect(within(tr[0] as HTMLElement).getByText("b")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Leads/ }));
    tr = tbody.querySelectorAll("tr");
    expect(within(tr[0] as HTMLElement).getByText("b")).toBeInTheDocument();
  });

  it("sorts by window days", async () => {
    const rows = [
      row({ id: "a", campaign_id: "a", window_days: 1 }),
      row({ id: "b", campaign_id: "b", window_days: 30 }),
    ];
    render(<PerfTable rows={rows} format="image" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Win\./ }));
    const tbody = document.querySelector("tbody")!;
    const tr = tbody.querySelectorAll("tr");
    expect(within(tr[0] as HTMLElement).getByText("b")).toBeInTheDocument();
  });

  it("sorts by CPL", async () => {
    const rows = [
      row({ id: "a", campaign_id: "a", cpl_real: 100 }),
      row({ id: "b", campaign_id: "b", cpl_real: 25 }),
    ];
    render(<PerfTable rows={rows} format="image" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /CPL/ }));
    const tbody = document.querySelector("tbody")!;
    const tr = tbody.querySelectorAll("tr");
    expect(within(tr[0] as HTMLElement).getByText("a")).toBeInTheDocument();
  });

  it("sorts by Format column in combined mode", async () => {
    const rows = [
      row({ id: "a", campaign_id: "a", format: "video" }),
      row({ id: "b", campaign_id: "b", format: "image" }),
    ];
    render(<PerfTable rows={rows} format="combined" />);

    const user = userEvent.setup();
    // 'Format' header is in this mode.
    await user.click(screen.getByRole("button", { name: /^Format$/ }));
    const tbody = document.querySelector("tbody")!;
    const tr = tbody.querySelectorAll("tr");
    expect(within(tr[0] as HTMLElement).getByText("b")).toBeInTheDocument(); // image
  });

  it("places nulls last in the sort order regardless of direction", async () => {
    const rows = [
      row({ id: "a", campaign_id: "a", spend: null }),
      row({ id: "b", campaign_id: "b", spend: 50 }),
    ];
    render(<PerfTable rows={rows} format="image" />);

    const tbody = document.querySelector("tbody")!;
    let tr = tbody.querySelectorAll("tr");
    // Default sort spend desc — 50 first, null last.
    expect(within(tr[0] as HTMLElement).getByText("b")).toBeInTheDocument();
    expect(within(tr[1] as HTMLElement).getByText("a")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Spend/ }));
    tr = tbody.querySelectorAll("tr");
    // ASC — null still last
    expect(within(tr[1] as HTMLElement).getByText("a")).toBeInTheDocument();
  });

  it("places verdict=null after keep in severity sort", async () => {
    const rows = [
      row({ id: "a", campaign_id: "a", verdict: null }),
      row({ id: "b", campaign_id: "b", verdict: "keep" }),
    ];
    render(<PerfTable rows={rows} format="image" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Verdict/ }));
    const tbody = document.querySelector("tbody")!;
    const tr = tbody.querySelectorAll("tr");
    expect(within(tr[0] as HTMLElement).getByText("b")).toBeInTheDocument(); // keep
    expect(within(tr[1] as HTMLElement).getByText("a")).toBeInTheDocument(); // null
  });
});
