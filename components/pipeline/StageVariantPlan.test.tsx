/**
 * StageVariantPlan: shows the A/B matrix + approve/reject; approve POSTs to the
 * variant-plan decision route.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { StageVariantPlan, type VariantPlanCellView } from "./StageVariantPlan";

const cells: VariantPlanCellView[] = [
  { id: "c1", cell_index: 0, label: "A", creative_id: "aaa", copy_variant_id: "bbb" },
  { id: "c2", cell_index: 1, label: "B", creative_id: "ccc", copy_variant_id: null },
];

beforeEach(() => routerRefresh.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("StageVariantPlan", () => {
  it("renders the plan + cells", () => {
    render(
      <StageVariantPlan
        pipelineId="p1"
        testVariable="creative"
        hypothesis="A beats B"
        cells={cells}
      />,
    );
    expect(screen.getByTestId("variant-cells").children).toHaveLength(2);
  });

  it("approves the plan via the decision route", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ pipeline: { status: "finalize_assets" } }));
    const user = userEvent.setup();
    render(
      <StageVariantPlan pipelineId="p1" testVariable="creative" hypothesis={null} cells={cells} />,
    );
    await user.click(screen.getByTestId("approve-plan"));
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/pipelines/p1/variant-plan/decision",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("rejects with a reason prompt", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("too narrow");
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ pipeline: {} }));
    const user = userEvent.setup();
    render(
      <StageVariantPlan pipelineId="p1" testVariable={null} hypothesis={null} cells={cells} />,
    );
    await user.click(screen.getByTestId("reject-plan"));
    await waitFor(() => {
      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.decision).toBe("rejected");
    });
  });

  it("aborts reject when the prompt is cancelled", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("");
    const fetchSpy = spyOnFetch();
    const user = userEvent.setup();
    render(
      <StageVariantPlan pipelineId="p1" testVariable={null} hypothesis={null} cells={cells} />,
    );
    await user.click(screen.getByTestId("reject-plan"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces an error inline", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ error: "no" }, { status: 500 }));
    const user = userEvent.setup();
    render(
      <StageVariantPlan pipelineId="p1" testVariable="copy" hypothesis={null} cells={cells} />,
    );
    await user.click(screen.getByTestId("approve-plan"));
    await waitFor(() => expect(screen.getByText("no")).toBeInTheDocument());
  });

  it("surfaces a network error inline", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(
      <StageVariantPlan pipelineId="p1" testVariable="copy" hypothesis={null} cells={cells} />,
    );
    await user.click(screen.getByTestId("approve-plan"));
    await waitFor(() => expect(screen.getByText("offline")).toBeInTheDocument());
  });

  it("falls back to a status message when the error body is empty", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({}, { status: 502 }));
    const user = userEvent.setup();
    render(
      <StageVariantPlan pipelineId="p1" testVariable="copy" hypothesis={null} cells={cells} />,
    );
    await user.click(screen.getByTestId("approve-plan"));
    await waitFor(() => expect(screen.getByText(/502/)).toBeInTheDocument());
  });

  it("renders an empty cells state", () => {
    render(<StageVariantPlan pipelineId="p1" testVariable={null} hypothesis={null} cells={[]} />);
    expect(screen.getByText(/No test cells/)).toBeInTheDocument();
  });
});
