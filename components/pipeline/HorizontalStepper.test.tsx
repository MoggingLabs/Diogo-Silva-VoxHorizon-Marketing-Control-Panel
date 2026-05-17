/**
 * Exemplar client-component test. Demonstrates:
 *  - Rendering a "use client" component with React Testing Library.
 *  - Asserting on per-stage state via accessible names.
 *  - Driving user input through `@testing-library/user-event`.
 *  - Verifying the mobile layout collapses (both DOM trees are rendered
 *    — Tailwind's `md:` toggles visibility — so we assert each one's
 *    own row independently).
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HorizontalStepper } from "./HorizontalStepper";
import { PIPELINE_STAGES, type PipelineStatus } from "@/lib/pipeline/types";

const stages = [...PIPELINE_STAGES];

/**
 * Pull just the desktop-row buttons. The component renders both a
 * desktop `<ol>` and a mobile `<ol>` with the same `aria-label`, so we
 * scope queries to the one we want.
 */
function getDesktopButtons() {
  const lists = screen.getAllByRole("list", { name: /pipeline progress/i });
  // Desktop list has `md:flex` and is the first in source order.
  const desktop = lists[0]!;
  return within(desktop).getAllByRole("button");
}

function getMobileButtons() {
  const lists = screen.getAllByRole("list", { name: /pipeline progress/i });
  const mobile = lists[1]!;
  return within(mobile).getAllByRole("button");
}

describe("HorizontalStepper", () => {
  it("marks the first stage as active when current = configuration", () => {
    render(<HorizontalStepper stages={stages} current="configuration" />);

    const buttons = getDesktopButtons();
    expect(buttons[0]).toHaveAttribute("aria-label", expect.stringContaining("active"));
    expect(buttons[1]).toHaveAttribute("aria-label", expect.stringContaining("future"));
    expect(buttons[4]).toHaveAttribute("aria-label", expect.stringContaining("future"));
  });

  it("marks earlier stages as past and later ones as future when current = review", () => {
    render(<HorizontalStepper stages={stages} current="review" />);

    const buttons = getDesktopButtons();
    expect(buttons[0]!.getAttribute("aria-label")).toMatch(/past/);
    expect(buttons[1]!.getAttribute("aria-label")).toMatch(/past/);
    expect(buttons[2]!.getAttribute("aria-label")).toMatch(/active/);
    expect(buttons[3]!.getAttribute("aria-label")).toMatch(/future/);
    expect(buttons[4]!.getAttribute("aria-label")).toMatch(/future/);
  });

  it("renders a check icon for past stages and an index number for future stages", () => {
    const { container } = render(<HorizontalStepper stages={stages} current="generation" />);

    const buttons = getDesktopButtons();
    // First 3 are past → contain svg.lucide-check; the active stage (idx 3)
    // shows the number 4, and the only future stage (idx 4) shows "5".
    expect(buttons[0]!.querySelector("svg")).not.toBeNull();
    expect(buttons[1]!.querySelector("svg")).not.toBeNull();
    expect(buttons[2]!.querySelector("svg")).not.toBeNull();
    expect(buttons[3]!.textContent).toContain("4");
    expect(buttons[4]!.textContent).toContain("5");

    // Sanity: there are buttons in the container at all.
    expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
  });

  it("treats `cancelled` (off-flow) by marking every stage as future", () => {
    render(<HorizontalStepper stages={stages} current={"cancelled" as PipelineStatus} />);

    for (const btn of getDesktopButtons()) {
      expect(btn.getAttribute("aria-label")).toMatch(/future/);
    }
  });

  it("invokes onStageClick when a past stage is clicked", async () => {
    const onStageClick = vi.fn();
    render(<HorizontalStepper stages={stages} current="generation" onStageClick={onStageClick} />);

    const user = userEvent.setup();
    const buttons = getDesktopButtons();
    // The first stage (configuration) is past — click it.
    await user.click(buttons[0]!);
    expect(onStageClick).toHaveBeenCalledWith("configuration");
  });

  it("does not invoke onStageClick when the active stage is clicked", () => {
    const onStageClick = vi.fn();
    render(<HorizontalStepper stages={stages} current="review" onStageClick={onStageClick} />);

    const buttons = getDesktopButtons();
    // Active button is disabled — userEvent throws on disabled. Fall back
    // to fireEvent and verify nothing fired.
    fireEvent.click(buttons[2]!);
    expect(onStageClick).not.toHaveBeenCalled();
  });

  it("does not invoke onStageClick when a future stage is clicked", () => {
    const onStageClick = vi.fn();
    render(
      <HorizontalStepper stages={stages} current="configuration" onStageClick={onStageClick} />,
    );

    const buttons = getDesktopButtons();
    fireEvent.click(buttons[3]!);
    expect(onStageClick).not.toHaveBeenCalled();
  });

  it("disables clicking when no onStageClick handler is provided", () => {
    render(<HorizontalStepper stages={stages} current="review" />);

    for (const btn of getDesktopButtons()) {
      expect(btn).toBeDisabled();
    }
  });

  it("renders a parallel mobile pill stack with the same five stages", () => {
    render(<HorizontalStepper stages={stages} current="ideation" />);

    const mobile = getMobileButtons();
    expect(mobile).toHaveLength(5);
    // The active stage is the second one (ideation).
    expect(mobile[0]!.getAttribute("aria-label")).toMatch(/past/);
    expect(mobile[1]!.getAttribute("aria-label")).toMatch(/active/);
    expect(mobile[2]!.getAttribute("aria-label")).toMatch(/future/);
  });

  it("fires onStageClick from the mobile pill stack too", async () => {
    const onStageClick = vi.fn();
    render(<HorizontalStepper stages={stages} current="done" onStageClick={onStageClick} />);

    const user = userEvent.setup();
    const mobile = getMobileButtons();
    // Click the very first (configuration) — it's in the past relative
    // to current = "done".
    await user.click(mobile[0]!);
    expect(onStageClick).toHaveBeenCalledWith("configuration");
  });

  it("sets aria-current=step on the active stage in both layouts", () => {
    render(<HorizontalStepper stages={stages} current="review" />);

    const lists = screen.getAllByRole("list", { name: /pipeline progress/i });
    for (const list of lists) {
      const activeItem = within(list)
        .getAllByRole("listitem")
        .find((li) => li.getAttribute("aria-current") === "step");
      expect(activeItem).toBeDefined();
    }
  });
});
