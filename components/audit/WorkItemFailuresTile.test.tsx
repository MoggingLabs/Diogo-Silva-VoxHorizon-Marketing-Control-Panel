/**
 * Tests for WorkItemFailuresTile (silent-failure PR-2a).
 *
 * Pure-render component, no fetch. Covers:
 *  - empty rows renders NOTHING (an empty board is a healthy board).
 *  - groups by error_kind, sorts by count desc.
 *  - shows up to 5 rows per group, with the kind + attempt + truncated msg.
 *  - deep-links to /pipeline/[id] when pipeline_id is set.
 *  - falls back to "(unclassified)" when error_kind is null.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WorkItemFailuresTile, type WorkItemFailureRow } from "./WorkItemFailuresTile";

function row(over: Partial<WorkItemFailureRow> = {}): WorkItemFailureRow {
  return {
    id: "wi-1",
    kind: "operator_dispatch",
    pipeline_id: "p1",
    status: "failed",
    error_kind: "auth_expired",
    error_detail: { msg: "Codex OAuth refresh failed: 401" },
    attempt: 2,
    created_at: "2026-05-26T12:00:00Z",
    ...over,
  };
}

describe("WorkItemFailuresTile", () => {
  it("renders nothing when there are no failures", () => {
    const { container } = render(<WorkItemFailuresTile rows={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("groups rows by error_kind and shows the count", () => {
    render(
      <WorkItemFailuresTile
        rows={[
          row({ id: "a", error_kind: "auth_expired" }),
          row({ id: "b", error_kind: "auth_expired" }),
          row({ id: "c", error_kind: "llm_5xx" }),
        ]}
      />,
    );
    expect(screen.getByTestId("work-item-failures-tile")).toBeInTheDocument();
    // The most-frequent class (auth_expired, 2) should appear first.
    const groups = screen
      .getAllByTestId(/work-item-failure-group-/)
      .map((g) => g.getAttribute("data-testid"));
    expect(groups[0]).toBe("work-item-failure-group-auth_expired");
    expect(groups[1]).toBe("work-item-failure-group-llm_5xx");
  });

  it("renders a deep link to /pipeline/[id] for each row", () => {
    render(<WorkItemFailuresTile rows={[row({ id: "a", pipeline_id: "p99" })]} />);
    const link = screen.getByTestId("work-item-failure-row-a") as HTMLAnchorElement;
    expect(link.href).toMatch(/\/pipeline\/p99/);
  });

  it("falls back to '(unclassified)' when error_kind is null", () => {
    render(<WorkItemFailuresTile rows={[row({ id: "a", error_kind: null })]} />);
    expect(screen.getByTestId("work-item-failure-group-(unclassified)")).toBeInTheDocument();
  });

  it("caps each group at 5 visible rows", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      row({ id: `row-${i}`, error_kind: "llm_5xx" }),
    );
    render(<WorkItemFailuresTile rows={many} />);
    const group = screen.getByTestId("work-item-failure-group-llm_5xx");
    const items = within(group).getAllByTestId(/work-item-failure-row-/);
    expect(items.length).toBe(5);
    // The group count chip still reflects the FULL count (7), not the capped 5.
    expect(group.textContent).toContain("7");
  });

  it("truncates long error_detail.msg with an ellipsis", () => {
    const long = "x".repeat(200);
    render(<WorkItemFailuresTile rows={[row({ id: "a", error_detail: { msg: long } })]} />);
    const item = screen.getByTestId("work-item-failure-row-a");
    expect(item.textContent?.includes("…")).toBe(true);
  });

  it("renders without a link when pipeline_id is null", () => {
    render(<WorkItemFailuresTile rows={[row({ id: "a", pipeline_id: null })]} />);
    // The wrapper is a div, not an anchor.
    const item = screen.getByTestId("work-item-failure-row-a");
    expect(item.tagName).toBe("DIV");
  });

  it("shows the row attempt + kind in the header line", () => {
    render(
      <WorkItemFailuresTile rows={[row({ id: "a", kind: "kie_video_render", attempt: 4 })]} />,
    );
    const item = screen.getByTestId("work-item-failure-row-a");
    expect(item.textContent).toContain("kie_video_render");
    expect(item.textContent).toContain("attempt 4");
  });
});
