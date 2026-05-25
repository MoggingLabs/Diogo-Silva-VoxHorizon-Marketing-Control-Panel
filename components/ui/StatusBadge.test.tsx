/**
 * Tests for the canonical StatusBadge + resolveStatus semantic map.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { resolveStatus, StatusBadge } from "./StatusBadge";

describe("resolveStatus", () => {
  it.each([
    ["approved", "success"],
    ["posted", "success"],
    ["live", "success"],
    ["pass", "success"],
    ["passed", "success"],
    ["completed", "success"],
    ["rejected", "destructive"],
    ["failed", "destructive"],
    ["fail", "destructive"],
    ["killed", "destructive"],
    ["error", "destructive"],
    ["cancelled", "destructive"],
    ["pending", "warning"],
    ["in_progress", "warning"],
    ["running", "warning"],
    ["overridden", "warning"],
    ["draft", "info"],
    ["queued", "info"],
    ["archived", "muted"],
    ["skipped", "muted"],
  ] as const)("maps %s -> %s", (status, semantic) => {
    expect(resolveStatus(status).semantic).toBe(semantic);
  });

  it("normalizes casing and separators", () => {
    expect(resolveStatus("In Progress").semantic).toBe("warning");
    expect(resolveStatus("in-progress").semantic).toBe("warning");
    expect(resolveStatus("APPROVED").semantic).toBe("success");
  });

  it("falls back to muted + humanized label for unknown statuses", () => {
    const r = resolveStatus("some_weird_state");
    expect(r.semantic).toBe("muted");
    expect(r.label).toBe("Some weird state");
  });

  it("flags spin for in-flight states", () => {
    expect(resolveStatus("running").spin).toBe(true);
    expect(resolveStatus("approved").spin).toBe(false);
  });
});

describe("StatusBadge", () => {
  it("renders the humanized label and exposes data attributes", () => {
    render(<StatusBadge status="in_progress" />);
    const badge = screen.getByText("In progress");
    const el = badge.closest("[data-status]");
    expect(el).toHaveAttribute("data-status", "in_progress");
    expect(el).toHaveAttribute("data-semantic", "warning");
  });

  it("honours an explicit label override", () => {
    render(<StatusBadge status="approved" label="Go live" />);
    expect(screen.getByText("Go live")).toBeInTheDocument();
  });

  it("can hide the icon", () => {
    const { container } = render(<StatusBadge status="approved" hideIcon />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
