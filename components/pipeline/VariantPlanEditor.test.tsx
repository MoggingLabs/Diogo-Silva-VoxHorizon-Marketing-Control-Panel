/**
 * VariantPlanEditor (E5.2 / #596): craft the A/B plan + cells. Save plan and
 * cell mutations POST/PUT/PATCH/DELETE to the variant-plan editor routes.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

import { VariantPlanEditor } from "./VariantPlanEditor";
import type { VariantPlanCell } from "@/lib/variant-plan/client";

const creatives = [
  { id: "cr1", concept: "Hero" },
  { id: "cr2", concept: "Lifestyle" },
];
const copyVariants = [
  { id: "cv1", creative_id: "cr1", headline: "Hook A", variant_index: 0 },
  { id: "cv2", creative_id: "cr1", headline: "Hook B", variant_index: 1 },
];
const cells: VariantPlanCell[] = [
  {
    id: "cell1",
    variant_plan_id: "vp1",
    cell_index: 0,
    creative_id: "cr1",
    copy_variant_id: null,
    audience: null,
    label: "A",
  },
];

beforeEach(() => {
  routerRefresh.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("VariantPlanEditor", () => {
  it("prompts to create the plan first when none exists", () => {
    render(
      <VariantPlanEditor
        pipelineId="p1"
        planExists={false}
        testVariable={null}
        hypothesis={null}
        initialCells={[]}
        creatives={creatives}
        copyVariants={copyVariants}
      />,
    );
    expect(screen.getByText(/Create the plan first/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create plan/i })).toBeInTheDocument();
  });

  it("renders existing cells", () => {
    render(
      <VariantPlanEditor
        pipelineId="p1"
        planExists
        testVariable="creative"
        hypothesis="A beats B"
        initialCells={cells}
        creatives={creatives}
        copyVariants={copyVariants}
      />,
    );
    expect(screen.getByTestId("variant-editor-cells").children).toHaveLength(1);
  });

  it("saves the plan via PUT", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ plan: { id: "vp1", status: "draft" } }));
    const user = userEvent.setup();
    render(
      <VariantPlanEditor
        pipelineId="p1"
        planExists
        testVariable="creative"
        hypothesis={null}
        initialCells={cells}
        creatives={creatives}
        copyVariants={copyVariants}
      />,
    );
    await user.click(screen.getByRole("button", { name: /save plan/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("/api/pipelines/p1/variant-plan");
    expect(init?.method).toBe("PUT");
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("adds a cell via POST", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          cell: {
            id: "cellN",
            cell_index: 1,
            creative_id: null,
            copy_variant_id: null,
            label: null,
          },
        },
        { status: 201 },
      ),
    );
    const user = userEvent.setup();
    render(
      <VariantPlanEditor
        pipelineId="p1"
        planExists
        testVariable="creative"
        hypothesis={null}
        initialCells={cells}
        creatives={creatives}
        copyVariants={copyVariants}
      />,
    );
    await user.click(screen.getByRole("button", { name: /add cell/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("/api/pipelines/p1/variant-plan/cells");
    expect(init?.method).toBe("POST");
  });

  it("removes a cell via DELETE", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ cell: { id: "cell1" } }));
    const user = userEvent.setup();
    render(
      <VariantPlanEditor
        pipelineId="p1"
        planExists
        testVariable="creative"
        hypothesis={null}
        initialCells={cells}
        creatives={creatives}
        copyVariants={copyVariants}
      />,
    );
    await user.click(screen.getByRole("button", { name: /remove cell 0/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("/api/pipelines/p1/variant-plan/cells/cell1");
    expect(init?.method).toBe("DELETE");
  });

  it("renders read-only with a lock hint when locked", () => {
    render(
      <VariantPlanEditor
        pipelineId="p1"
        planExists
        locked
        testVariable="creative"
        hypothesis={null}
        initialCells={cells}
        creatives={creatives}
        copyVariants={copyVariants}
      />,
    );
    expect(screen.getByText(/Approved plans are locked/i)).toBeInTheDocument();
    // No save / add / remove controls when locked.
    expect(screen.queryByRole("button", { name: /save plan/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add cell/i })).not.toBeInTheDocument();
  });

  it("edits a cell's label on blur (PATCH)", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ cell: { id: "cell1", label: "B" } }));
    const user = userEvent.setup();
    render(
      <VariantPlanEditor
        pipelineId="p1"
        planExists
        testVariable="creative"
        hypothesis={null}
        initialCells={cells}
        creatives={creatives}
        copyVariants={copyVariants}
      />,
    );
    const labelInput = screen.getByLabelText(/cell 0 label/i);
    await user.clear(labelInput);
    await user.type(labelInput, "B");
    await user.tab(); // blur -> patch
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("/api/pipelines/p1/variant-plan/cells/cell1");
    expect(init?.method).toBe("PATCH");
  });

  it("toasts an error when saving the plan fails", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, { status: 500 }));
    const user = userEvent.setup();
    render(
      <VariantPlanEditor
        pipelineId="p1"
        planExists
        testVariable="creative"
        hypothesis={null}
        initialCells={cells}
        creatives={creatives}
        copyVariants={copyVariants}
      />,
    );
    await user.click(screen.getByRole("button", { name: /save plan/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it("toasts an error when removing a cell fails", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ error: "nope" }, { status: 500 }));
    const user = userEvent.setup();
    render(
      <VariantPlanEditor
        pipelineId="p1"
        planExists
        testVariable="creative"
        hypothesis={null}
        initialCells={cells}
        creatives={creatives}
        copyVariants={copyVariants}
      />,
    );
    await user.click(screen.getByRole("button", { name: /remove cell 0/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it("toasts an error when adding a cell fails", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ error: "nope" }, { status: 500 }));
    const user = userEvent.setup();
    render(
      <VariantPlanEditor
        pipelineId="p1"
        planExists
        testVariable="creative"
        hypothesis={null}
        initialCells={cells}
        creatives={creatives}
        copyVariants={copyVariants}
      />,
    );
    await user.click(screen.getByRole("button", { name: /add cell/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it("creates the plan (planExists=false) via PUT and toasts success", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(
      jsonResponse({ plan: { id: "vpNew", status: "draft" } }, { status: 201 }),
    );
    const user = userEvent.setup();
    render(
      <VariantPlanEditor
        pipelineId="p1"
        planExists={false}
        testVariable={null}
        hypothesis={null}
        initialCells={[]}
        creatives={creatives}
        copyVariants={copyVariants}
      />,
    );
    await user.click(screen.getByRole("button", { name: /create plan/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("PUT");
    expect(toastSuccess).toHaveBeenCalled();
  });
});
