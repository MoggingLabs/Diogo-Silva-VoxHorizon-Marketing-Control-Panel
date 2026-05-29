/**
 * Tests for the shared launch status badge + optimistic-status provider.
 *
 * Covers:
 *   - The badge renders the server status when no provider wraps it.
 *   - The badge renders the provider's status when one is present.
 *   - An unknown status falls back to the "posted" styling/label path.
 *   - launchStatusLabel maps known statuses and passes unknowns through.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LaunchStatusBadge, LaunchStatusProvider, launchStatusLabel } from "./LaunchStatusBadge";

describe("LaunchStatusBadge", () => {
  it("renders the server status when no provider is present", () => {
    render(<LaunchStatusBadge status="posted" />);
    expect(screen.getByText("Posted", { exact: true })).toBeInTheDocument();
  });

  it("renders the provider's seeded status", () => {
    render(
      <LaunchStatusProvider serverStatus="approved">
        <LaunchStatusBadge status="approved" />
      </LaunchStatusProvider>,
    );
    expect(screen.getByText("Approved", { exact: true })).toBeInTheDocument();
  });

  it("passes an unknown status through as its own label", () => {
    render(<LaunchStatusBadge status="weird_state" />);
    expect(screen.getByText("weird_state", { exact: true })).toBeInTheDocument();
  });

  it("seeds the provider to posted when the server status is unknown", () => {
    render(
      <LaunchStatusProvider serverStatus="weird_state">
        <LaunchStatusBadge status="weird_state" />
      </LaunchStatusProvider>,
    );
    expect(screen.getByText("Posted", { exact: true })).toBeInTheDocument();
  });
});

describe("launchStatusLabel", () => {
  it("maps known statuses to their label", () => {
    expect(launchStatusLabel("approved_with_changes")).toBe("Approved with changes");
    expect(launchStatusLabel("rejected")).toBe("Rejected");
  });

  it("passes unknown statuses through unchanged", () => {
    expect(launchStatusLabel("weird_state")).toBe("weird_state");
  });
});
