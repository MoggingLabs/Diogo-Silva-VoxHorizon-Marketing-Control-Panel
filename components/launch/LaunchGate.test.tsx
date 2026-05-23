/**
 * LaunchGate (#361): preconditions checklist; launch disabled until all green +
 * both confirmations; overrides re-surfaced; POSTs to launch/decision.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { LaunchGate } from "./LaunchGate";
import type { GridCreative, LaunchCopyVariant, StageStateRow } from "@/lib/review/grid";

const creatives: GridCreative[] = [{ id: "a", concept: "Concept A", status: "approved" }];

const readyStates: StageStateRow[] = [
  { creative_id: "a", stage: "compliance_review", status: "passed", override_note: null },
  { creative_id: "a", stage: "spec_validation", status: "passed", override_note: null },
];

const overriddenStates: StageStateRow[] = [
  {
    creative_id: "a",
    stage: "compliance_review",
    status: "overridden",
    override_note: "legal cleared",
  },
  { creative_id: "a", stage: "spec_validation", status: "passed", override_note: null },
];

const approvedCopy: LaunchCopyVariant[] = [
  { creative_id: "a", status: "approved" },
  { creative_id: "a", status: "approved" },
  { creative_id: "a", status: "approved" },
];

beforeEach(() => routerRefresh.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("LaunchGate", () => {
  it("renders the preconditions checklist with per-item state", () => {
    render(
      <LaunchGate
        pipelineId="p1"
        creatives={creatives}
        states={readyStates}
        copyVariants={approvedCopy}
      />,
    );
    expect(screen.getByTestId("precondition-compliance_clear")).toHaveAttribute("data-met", "true");
    expect(screen.getByTestId("precondition-spec_pass")).toHaveAttribute("data-met", "true");
    expect(screen.getByTestId("precondition-copy_ge_3")).toHaveAttribute("data-met", "true");
  });

  it("disables Launch until all green and both confirmations checked", async () => {
    const user = userEvent.setup();
    render(
      <LaunchGate
        pipelineId="p1"
        creatives={creatives}
        states={readyStates}
        copyVariants={approvedCopy}
      />,
    );
    const launch = screen.getByTestId("launch-button");
    expect(launch).toBeDisabled();
    await user.click(screen.getByTestId("confirm-paused-first"));
    expect(launch).toBeDisabled();
    await user.click(screen.getByTestId("acknowledge-preconditions"));
    expect(launch).not.toBeDisabled();
  });

  it("keeps Launch disabled when a precondition is unmet", () => {
    render(
      <LaunchGate
        pipelineId="p1"
        creatives={creatives}
        states={readyStates}
        copyVariants={[{ creative_id: "a", status: "approved" }]}
      />,
    );
    expect(screen.getByTestId("precondition-copy_ge_3")).toHaveAttribute("data-met", "false");
    expect(screen.getByTestId("launch-button")).toBeDisabled();
  });

  it("re-surfaces compliance overrides", () => {
    render(
      <LaunchGate
        pipelineId="p1"
        creatives={creatives}
        states={overriddenStates}
        copyVariants={approvedCopy}
      />,
    );
    expect(screen.getByTestId("resurfaced-overrides")).toHaveTextContent("legal cleared");
  });

  it("POSTs the approved decision with both confirmations", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ pipeline: { status: "monitor" } }));
    const user = userEvent.setup();
    render(
      <LaunchGate
        pipelineId="p1"
        creatives={creatives}
        states={readyStates}
        copyVariants={approvedCopy}
      />,
    );
    await user.click(screen.getByTestId("confirm-paused-first"));
    await user.click(screen.getByTestId("acknowledge-preconditions"));
    await user.click(screen.getByTestId("launch-button"));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/pipelines/p1/launch/decision",
        expect.objectContaining({ method: "POST" }),
      );
      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      expect(body).toMatchObject({
        decision: "approved",
        confirm_paused_first: true,
        acknowledge_preconditions: true,
      });
    });
  });

  it("surfaces a server block reason inline", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ reason: "blocked by server" }, { status: 422 }));
    const user = userEvent.setup();
    render(
      <LaunchGate
        pipelineId="p1"
        creatives={creatives}
        states={readyStates}
        copyVariants={approvedCopy}
      />,
    );
    await user.click(screen.getByTestId("confirm-paused-first"));
    await user.click(screen.getByTestId("acknowledge-preconditions"));
    await user.click(screen.getByTestId("launch-button"));
    await waitFor(() =>
      expect(screen.getByTestId("launch-error")).toHaveTextContent("blocked by server"),
    );
  });

  it("falls back to the error field then a status message", async () => {
    const fetchSpy = spyOnFetch();
    // No `reason`, only `error`.
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "err only" }, { status: 500 }));
    const user = userEvent.setup();
    const { unmount } = render(
      <LaunchGate
        pipelineId="p1"
        creatives={creatives}
        states={readyStates}
        copyVariants={approvedCopy}
      />,
    );
    await user.click(screen.getByTestId("confirm-paused-first"));
    await user.click(screen.getByTestId("acknowledge-preconditions"));
    await user.click(screen.getByTestId("launch-button"));
    await waitFor(() => expect(screen.getByTestId("launch-error")).toHaveTextContent("err only"));
    unmount();

    // Neither reason nor error → status fallback.
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, { status: 503 }));
    render(
      <LaunchGate
        pipelineId="p1"
        creatives={creatives}
        states={readyStates}
        copyVariants={approvedCopy}
      />,
    );
    await user.click(screen.getByTestId("confirm-paused-first"));
    await user.click(screen.getByTestId("acknowledge-preconditions"));
    await user.click(screen.getByTestId("launch-button"));
    await waitFor(() => expect(screen.getByTestId("launch-error")).toHaveTextContent("503"));
  });

  it("surfaces a network error inline", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(
      <LaunchGate
        pipelineId="p1"
        creatives={creatives}
        states={readyStates}
        copyVariants={approvedCopy}
      />,
    );
    await user.click(screen.getByTestId("confirm-paused-first"));
    await user.click(screen.getByTestId("acknowledge-preconditions"));
    await user.click(screen.getByTestId("launch-button"));
    await waitFor(() => expect(screen.getByTestId("launch-error")).toHaveTextContent("offline"));
  });

  it("renders the LaunchSummary children slot", () => {
    render(
      <LaunchGate
        pipelineId="p1"
        creatives={creatives}
        states={readyStates}
        copyVariants={approvedCopy}
      >
        <div data-testid="summary-slot">summary</div>
      </LaunchGate>,
    );
    expect(screen.getByTestId("summary-slot")).toBeInTheDocument();
  });
});
