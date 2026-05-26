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
    // M8: pipeline lifecycle stages + format chips.
    ["configuration", "info"],
    ["ideation", "info"],
    ["generation", "info"],
    ["creative_qa", "warning"],
    ["compliance_review", "warning"],
    ["copy", "info"],
    ["spec_validation", "warning"],
    ["variant_plan", "warning"],
    ["finalize_assets", "info"],
    ["launch_handoff", "warning"],
    ["monitor", "info"],
    ["image", "info"],
    ["video", "info"],
    ["both", "success"],
    // M8: monitor verdicts (traffic-light: keep / watch / kill).
    ["keep", "success"],
    ["watch", "warning"],
    ["kill", "destructive"],
  ] as const)("maps %s -> %s", (status, semantic) => {
    expect(resolveStatus(status).semantic).toBe(semantic);
  });

  it("uses the curated pipeline labels (Spec validation, Variant plan, etc.)", () => {
    expect(resolveStatus("spec_validation").label).toBe("Spec validation");
    expect(resolveStatus("variant_plan").label).toBe("Variant plan");
    expect(resolveStatus("launch_handoff").label).toBe("Launch");
    expect(resolveStatus("both").label).toBe("Image + Video");
  });

  it("spins the generation badge (in-flight state)", () => {
    expect(resolveStatus("generation").spin).toBe(true);
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
