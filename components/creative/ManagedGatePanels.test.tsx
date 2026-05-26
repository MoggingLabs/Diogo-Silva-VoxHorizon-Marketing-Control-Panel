/**
 * ManagedGatePanels (M6): the protected-artifact managed surfaces.
 *
 * Verifies the CORRECT action is exposed per protected table (never a raw
 * edit/delete):
 *   - QA (append-only): a "Re-run QA" action calls the worker QA route, which
 *     appends a NEW attempt; the attempt history renders newest-first.
 *   - Spec (override-route): an Override action submits a corrected placement
 *     result with a REQUIRED reason.
 *   - Compliance (override-route): an Override action releases a hard block with
 *     a REQUIRED justification; only failing, non-overridden findings offer it.
 * Plus the no-pipeline guard (the worker tools are pipeline-scoped) and error
 * surfacing via toasts.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const rerunQaMock = vi.fn();
const overrideSpecMock = vi.fn();
const overrideComplianceMock = vi.fn();
vi.mock("@/lib/creatives-client", () => ({
  rerunQa: (...a: unknown[]) => rerunQaMock(...a),
  overrideSpec: (...a: unknown[]) => overrideSpecMock(...a),
  overrideCompliance: (...a: unknown[]) => overrideComplianceMock(...a),
}));

import { ManagedGatePanels } from "./ManagedGatePanels";

const creativeId = "c1";
const pipelineId = "pp1";

const baseProps = {
  creativeId,
  pipelineId,
  surface: "image" as const,
  qa: [] as Array<Record<string, unknown> & { id: string }>,
  spec: [] as Array<Record<string, unknown> & { id: string }>,
  compliance: [] as Array<Record<string, unknown> & { id: string }>,
};

beforeEach(() => {
  routerRefresh.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  rerunQaMock.mockReset();
  overrideSpecMock.mockReset();
  overrideComplianceMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// QA — append-only re-run
// ---------------------------------------------------------------------------

describe("QA re-run (append-only)", () => {
  it("shows an empty state + the append-only hint", () => {
    render(<ManagedGatePanels {...baseProps} />);
    expect(screen.getByText(/No QA attempts yet/i)).toBeInTheDocument();
    expect(screen.getByText(/a re-run posts a new attempt/i)).toBeInTheDocument();
  });

  it("renders the attempt history newest-first with a defect count", () => {
    render(
      <ManagedGatePanels
        {...baseProps}
        qa={[
          { id: "a1", attempt: 1, status: "fail", defects: [{ defect_class: "hands" }] },
          { id: "a2", attempt: 2, status: "passed", defects: [] },
        ]}
      />,
    );
    const list = screen.getByTestId("qa-attempts");
    const items = within(list).getAllByText(/Attempt \d/);
    // Newest (attempt 2) first.
    expect(items[0]).toHaveTextContent("Attempt 2");
    expect(items[1]).toHaveTextContent("Attempt 1");
    expect(screen.getByText("1 defect(s)")).toBeInTheDocument();
  });

  it("re-runs QA via the worker route and refreshes", async () => {
    rerunQaMock.mockResolvedValue({
      ok: true,
      rollup: "passed",
      results: [{ creative_id: creativeId, verdict: "pass", status: "passed", attempt: 3 }],
      errors: [],
    });
    const user = userEvent.setup();
    render(<ManagedGatePanels {...baseProps} />);
    await user.click(screen.getByTestId("qa-rerun"));
    await waitFor(() => {
      expect(rerunQaMock).toHaveBeenCalledWith(creativeId, { surface: "image" });
      expect(routerRefresh).toHaveBeenCalled();
    });
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("attempt 3"));
  });

  it("toasts the worker's per-item error when the re-run reports one", async () => {
    rerunQaMock.mockResolvedValue({
      ok: true,
      rollup: "pending",
      results: [],
      errors: [{ creative_id: creativeId, error: "creative not found" }],
    });
    const user = userEvent.setup();
    render(<ManagedGatePanels {...baseProps} />);
    await user.click(screen.getByTestId("qa-rerun"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining("creative not found")),
    );
  });

  it("toasts a generic success when the worker returns no result and no error", async () => {
    rerunQaMock.mockResolvedValue({ ok: true, rollup: "pending", results: [], errors: [] });
    const user = userEvent.setup();
    render(<ManagedGatePanels {...baseProps} />);
    await user.click(screen.getByTestId("qa-rerun"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("QA re-run submitted"));
  });

  it("toasts the error when the worker call throws", async () => {
    rerunQaMock.mockRejectedValue(new Error("worker down"));
    const user = userEvent.setup();
    render(<ManagedGatePanels {...baseProps} />);
    await user.click(screen.getByTestId("qa-rerun"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("worker down"));
  });

  it("toasts a generic message when the worker throws a non-Error value", async () => {
    rerunQaMock.mockRejectedValue("string-throw");
    const user = userEvent.setup();
    render(<ManagedGatePanels {...baseProps} />);
    await user.click(screen.getByTestId("qa-rerun"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("QA re-run failed"));
  });

  it("renders dash fallbacks for a sparse QA attempt row (missing attempt + status)", () => {
    render(<ManagedGatePanels {...baseProps} qa={[{ id: "qa-bare" }]} />);
    expect(screen.getByText(/Attempt \?/)).toBeInTheDocument();
  });

  it("handles a non-numeric attempt value (string) when ordering attempts", () => {
    render(
      <ManagedGatePanels
        {...baseProps}
        qa={[
          { id: "qa-a", attempt: "1", status: "pass" },
          { id: "qa-b", attempt: 2, status: "fail" },
        ]}
      />,
    );
    // Both attempts render (string-typed attempts are coerced); newest first.
    const list = screen.getByTestId("qa-attempts");
    const items = within(list).getAllByText(/Attempt/);
    expect(items[0]).toHaveTextContent("Attempt 2");
  });

  it("coerces a missing attempt to 0 when ordering (exercises the ?? branch)", () => {
    render(
      <ManagedGatePanels
        {...baseProps}
        qa={[
          { id: "qa-known", attempt: 1, status: "pass" },
          { id: "qa-bare", status: "fail" },
        ]}
      />,
    );
    // The bare row sorts below the numbered attempt (attempt 1 > 0 fallback).
    const list = screen.getByTestId("qa-attempts");
    const items = within(list).getAllByText(/Attempt/);
    expect(items[0]).toHaveTextContent("Attempt 1");
    expect(items[1]).toHaveTextContent("Attempt ?");
  });

  it("disables re-run when the creative has no pipeline (guards the action upstream)", async () => {
    const user = userEvent.setup();
    render(<ManagedGatePanels {...baseProps} pipelineId={null} />);
    const btn = screen.getByTestId("qa-rerun");
    expect(btn).toBeDisabled();
    // A click on a disabled button is a no-op; the worker is not called.
    await user.click(btn);
    expect(rerunQaMock).not.toHaveBeenCalled();
  });

  it("passes the video surface through to the worker", async () => {
    rerunQaMock.mockResolvedValue({ ok: true, rollup: "passed", results: [], errors: [] });
    const user = userEvent.setup();
    render(<ManagedGatePanels {...baseProps} surface="video" />);
    await user.click(screen.getByTestId("qa-rerun"));
    await waitFor(() => expect(rerunQaMock).toHaveBeenCalledWith(creativeId, { surface: "video" }));
  });
});

// ---------------------------------------------------------------------------
// Spec — override-route only
// ---------------------------------------------------------------------------

describe("Spec override (override-route only)", () => {
  const spec = [{ id: "sp1", platform: "meta", placement: "feed", status: "fail", ratio: "1x1" }];

  it("shows an empty state when there are no spec checks", () => {
    render(<ManagedGatePanels {...baseProps} />);
    expect(screen.getByText(/No spec checks recorded/i)).toBeInTheDocument();
  });

  it("opens an override form, requires a reason, then submits the corrected result", async () => {
    overrideSpecMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<ManagedGatePanels {...baseProps} spec={spec} />);

    await user.click(screen.getByTestId("spec-override-open-sp1"));
    expect(screen.getByTestId("spec-override-form")).toBeInTheDocument();
    // Submit is disabled until a reason is typed.
    expect(screen.getByTestId("spec-override-submit")).toBeDisabled();

    await user.type(screen.getByTestId("spec-override-reason"), "Safe-zone within tolerance");
    await user.click(screen.getByTestId("spec-override-submit"));

    await waitFor(() => {
      expect(overrideSpecMock).toHaveBeenCalledWith(creativeId, {
        platform: "meta",
        placement: "feed",
        status: "pass",
        reason: "Safe-zone within tolerance",
        ratio: "1x1",
      });
      expect(routerRefresh).toHaveBeenCalled();
    });
    expect(toastSuccess).toHaveBeenCalledWith("Spec override submitted");
  });

  it("cancels the override form without submitting", async () => {
    const user = userEvent.setup();
    render(<ManagedGatePanels {...baseProps} spec={spec} />);
    await user.click(screen.getByTestId("spec-override-open-sp1"));
    expect(screen.getByTestId("spec-override-form")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByTestId("spec-override-form")).not.toBeInTheDocument();
    expect(overrideSpecMock).not.toHaveBeenCalled();
  });

  it("toasts when the spec override call throws", async () => {
    overrideSpecMock.mockRejectedValue(new Error("spec 502"));
    const user = userEvent.setup();
    render(<ManagedGatePanels {...baseProps} spec={spec} />);
    await user.click(screen.getByTestId("spec-override-open-sp1"));
    await user.type(screen.getByTestId("spec-override-reason"), "reason");
    await user.click(screen.getByTestId("spec-override-submit"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("spec 502"));
  });

  it("toasts a generic message when the spec override throws a non-Error value", async () => {
    overrideSpecMock.mockRejectedValue("non-error");
    const user = userEvent.setup();
    render(<ManagedGatePanels {...baseProps} spec={spec} />);
    await user.click(screen.getByTestId("spec-override-open-sp1"));
    await user.type(screen.getByTestId("spec-override-reason"), "reason");
    await user.click(screen.getByTestId("spec-override-submit"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Spec override failed"));
  });

  it("changes the corrected status via the dropdown before submitting", async () => {
    overrideSpecMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<ManagedGatePanels {...baseProps} spec={spec} />);
    await user.click(screen.getByTestId("spec-override-open-sp1"));
    // Open the Radix Select trigger and pick a non-default status.
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "warn" }));
    await user.type(screen.getByTestId("spec-override-reason"), "reason");
    await user.click(screen.getByTestId("spec-override-submit"));
    await waitFor(() =>
      expect(overrideSpecMock).toHaveBeenCalledWith(
        creativeId,
        expect.objectContaining({ status: "warn" }),
      ),
    );
  });

  it("renders the dash fallback for a sparse spec row (missing status)", () => {
    render(<ManagedGatePanels {...baseProps} spec={[{ id: "sp-bare" }]} />);
    // The row still renders (with dash + "unknown" status) without throwing.
    expect(screen.getByTestId("spec-override-open-sp-bare")).toBeInTheDocument();
  });

  it("defaults platform to meta + omits ratio for a sparse spec row", async () => {
    overrideSpecMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<ManagedGatePanels {...baseProps} spec={[{ id: "sp0" }]} />);
    await user.click(screen.getByTestId("spec-override-open-sp0"));
    await user.type(screen.getByTestId("spec-override-reason"), "reason");
    await user.click(screen.getByTestId("spec-override-submit"));
    await waitFor(() =>
      expect(overrideSpecMock).toHaveBeenCalledWith(creativeId, {
        platform: "meta",
        placement: "",
        status: "pass",
        reason: "reason",
      }),
    );
  });

  it("disables the spec override action when there is no pipeline", () => {
    render(<ManagedGatePanels {...baseProps} pipelineId={null} spec={spec} />);
    expect(screen.getByTestId("spec-override-open-sp1")).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Compliance — override-route only (existing pipeline route)
// ---------------------------------------------------------------------------

describe("Compliance override (override-route only)", () => {
  it("shows an empty state when there are no findings", () => {
    render(<ManagedGatePanels {...baseProps} />);
    expect(screen.getByText(/No compliance findings/i)).toBeInTheDocument();
  });

  it("does NOT offer an override when nothing is failing", () => {
    render(
      <ManagedGatePanels
        {...baseProps}
        compliance={[{ id: "cf1", rule_id: "R1", verdict: "pass", overridden: false }]}
      />,
    );
    expect(screen.queryByTestId("compliance-override-open")).not.toBeInTheDocument();
  });

  it("does NOT offer an override when the failing finding is already overridden", () => {
    render(
      <ManagedGatePanels
        {...baseProps}
        compliance={[{ id: "cf1", rule_id: "R1", verdict: "fail", overridden: true }]}
      />,
    );
    // The row shows the overridden tag, but no new override action.
    expect(screen.getByText("overridden")).toBeInTheDocument();
    expect(screen.queryByTestId("compliance-override-open")).not.toBeInTheDocument();
  });

  it("overrides a hard block with a required justification via the existing route", async () => {
    overrideComplianceMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <ManagedGatePanels
        {...baseProps}
        compliance={[{ id: "cf1", rule_id: "R1", verdict: "fail", overridden: false }]}
      />,
    );
    await user.click(screen.getByTestId("compliance-override-open"));
    // Submit gated on a non-empty note.
    expect(screen.getByTestId("compliance-override-submit")).toBeDisabled();
    await user.type(screen.getByTestId("compliance-override-note"), "Reviewed: vertical-compliant");
    await user.click(screen.getByTestId("compliance-override-submit"));

    await waitFor(() => {
      expect(overrideComplianceMock).toHaveBeenCalledWith(pipelineId, {
        creative_id: creativeId,
        override_note: "Reviewed: vertical-compliant",
      });
      expect(routerRefresh).toHaveBeenCalled();
    });
    expect(toastSuccess).toHaveBeenCalledWith("Compliance override recorded");
  });

  it("cancels the compliance override form", async () => {
    const user = userEvent.setup();
    render(
      <ManagedGatePanels
        {...baseProps}
        compliance={[{ id: "cf1", rule_id: "R1", verdict: "fail", overridden: false }]}
      />,
    );
    await user.click(screen.getByTestId("compliance-override-open"));
    expect(screen.getByTestId("compliance-override-form")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByTestId("compliance-override-form")).not.toBeInTheDocument();
  });

  it("toasts when the compliance override call throws", async () => {
    overrideComplianceMock.mockRejectedValue(new Error("compliance 500"));
    const user = userEvent.setup();
    render(
      <ManagedGatePanels
        {...baseProps}
        compliance={[{ id: "cf1", rule_id: "R1", verdict: "fail", overridden: false }]}
      />,
    );
    await user.click(screen.getByTestId("compliance-override-open"));
    await user.type(screen.getByTestId("compliance-override-note"), "note");
    await user.click(screen.getByTestId("compliance-override-submit"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("compliance 500"));
  });

  it("toasts a generic message when the compliance override throws a non-Error value", async () => {
    overrideComplianceMock.mockRejectedValue("non-error");
    const user = userEvent.setup();
    render(
      <ManagedGatePanels
        {...baseProps}
        compliance={[{ id: "cf1", rule_id: "R1", verdict: "fail", overridden: false }]}
      />,
    );
    await user.click(screen.getByTestId("compliance-override-open"));
    await user.type(screen.getByTestId("compliance-override-note"), "note");
    await user.click(screen.getByTestId("compliance-override-submit"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Compliance override failed"));
  });

  it("renders the dash fallback for a sparse finding row (missing rule_id + verdict)", () => {
    render(<ManagedGatePanels {...baseProps} compliance={[{ id: "cf-bare" }]} />);
    // The row renders without throwing; no override action because verdict is not "fail".
    expect(screen.queryByTestId("compliance-override-open")).not.toBeInTheDocument();
  });

  it("disables the compliance override action when there is no pipeline", () => {
    render(
      <ManagedGatePanels
        {...baseProps}
        pipelineId={null}
        compliance={[{ id: "cf1", rule_id: "R1", verdict: "fail", overridden: false }]}
      />,
    );
    expect(screen.getByTestId("compliance-override-open")).toBeDisabled();
  });
});
