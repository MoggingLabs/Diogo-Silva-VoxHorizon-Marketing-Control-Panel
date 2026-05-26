/**
 * CreativeManage (E4.2 / #594): the per-creative image manage surface.
 *
 * Tests cover: the decision section routes to DecisionButtons for a draft and
 * to a summary otherwise (guardrail: status changes go through the decision
 * route, not a raw edit), the metadata edit drawer PATCHes via the client,
 * archive + restore wiring, the copy variants + gate panels render, and the
 * pipeline review link surfaces the existing override/decision actions.
 */
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Creative } from "@/lib/creatives";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

const updateImageMock = vi.fn();
const archiveMock = vi.fn();
const restoreMock = vi.fn();
vi.mock("@/lib/creatives-client", () => ({
  updateImageCreative: (...a: unknown[]) => updateImageMock(...a),
  archiveCreative: (...a: unknown[]) => archiveMock(...a),
  restoreCreative: (...a: unknown[]) => restoreMock(...a),
}));

vi.mock("@/lib/realtime/client-data", () => ({
  fetchCreativeIterations: vi.fn(async () => []),
}));

vi.mock("@/components/creative/DecisionButtons", () => ({
  DecisionButtons: ({ creativeId }: { creativeId: string }) => (
    <div data-testid="decision-buttons" data-id={creativeId} />
  ),
}));
vi.mock("@/components/creative/IterationThread", () => ({
  IterationThread: () => <div data-testid="iteration-thread" />,
}));
// ManagedGatePanels (the protected-artifact managed surfaces) is covered by its
// own test; mock it here so CreativeManage tests stay focused on the page shell.
vi.mock("@/components/creative/ManagedGatePanels", () => ({
  ManagedGatePanels: ({
    creativeId,
    pipelineId,
    surface,
  }: {
    creativeId: string;
    pipelineId: string | null;
    surface: string;
  }) => (
    <div
      data-testid="managed-gate-panels"
      data-creative={creativeId}
      data-pipeline={pipelineId ?? ""}
      data-surface={surface}
    />
  ),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CreativeManage } from "./CreativeManage";

function creative(over: Partial<Creative> = {}): Creative {
  return {
    id: "c1",
    brief_id: "b1",
    type: "image",
    status: "draft",
    ratio: "1x1",
    version: "v1",
    concept: "Roof hook",
    offer_text: "20% off",
    asset_name: null,
    approved_at: null,
    finalized_at: null,
    finalize_verified: false,
    file_path_drive: null,
    file_path_supabase: "p1.png",
    drive_folder_id: null,
    concept_id: null,
    pipeline_id: "pp1",
    prompt_used: null,
    created_at: "2026-05-20T10:00:00Z",
    deleted_at: null,
    ...over,
  } as Creative;
}

const baseProps = {
  brief: { id: "b1", brief_id_human: "br-1", status: "approved", client_id: "cl1" },
  signedUrl: "https://signed/p1.png",
  copyVariants: [],
  qa: [],
  spec: [],
  compliance: [],
  stageState: [],
};

beforeEach(() => {
  routerRefresh.mockReset();
  updateImageMock.mockReset().mockResolvedValue({});
  archiveMock.mockReset().mockResolvedValue(undefined);
  restoreMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe("CreativeManage", () => {
  it("shows DecisionButtons for a draft creative (status via decision route)", () => {
    render(<CreativeManage creative={creative({ status: "draft" })} {...baseProps} />);
    expect(screen.getByTestId("decision-buttons")).toHaveAttribute("data-id", "c1");
    expect(screen.getByText(/Status changes go through the decision route/i)).toBeInTheDocument();
  });

  it("falls back to 'Untitled concept' when concept is null", () => {
    render(<CreativeManage creative={creative({ concept: null })} {...baseProps} />);
    expect(screen.getByRole("heading", { name: /Untitled concept/i })).toBeInTheDocument();
  });

  it("shows a decision summary (no DecisionButtons) once decided", () => {
    render(
      <CreativeManage
        creative={creative({ status: "approved", approved_at: "2026-05-21T00:00:00Z" })}
        {...baseProps}
      />,
    );
    expect(screen.queryByTestId("decision-buttons")).not.toBeInTheDocument();
    expect(screen.getByText(/Decided/i)).toBeInTheDocument();
  });

  it("edits metadata (incl. the ratio Select) through the drawer -> PATCH + refresh", async () => {
    const user = userEvent.setup();
    // Start with no ratio so the Select value maps "" -> sentinel.
    render(<CreativeManage creative={creative({ ratio: null })} {...baseProps} />);
    await user.click(screen.getByRole("button", { name: /edit metadata/i }));
    const dialog = await screen.findByRole("dialog");
    const concept = within(dialog).getByLabelText(/concept/i);
    await user.clear(concept);
    await user.type(concept, "New concept");
    // Change the ratio Select (covers the onValueChange sentinel mapping).
    await user.click(within(dialog).getByRole("combobox", { name: /ratio/i }));
    await user.click(await screen.findByRole("option", { name: "9x16" }));
    await user.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(updateImageMock).toHaveBeenCalled());
    expect(updateImageMock.mock.calls[0]![0]).toBe("c1");
    expect(updateImageMock.mock.calls[0]![1]).toMatchObject({
      concept: "New concept",
      ratio: "9x16",
    });
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("clears the ratio back to null via the No ratio option", async () => {
    const user = userEvent.setup();
    render(<CreativeManage creative={creative({ ratio: "1x1" })} {...baseProps} />);
    await user.click(screen.getByRole("button", { name: /edit metadata/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: /ratio/i }));
    await user.click(await screen.findByRole("option", { name: "No ratio" }));
    await user.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(updateImageMock).toHaveBeenCalled());
    expect(updateImageMock.mock.calls[0]![1]).toMatchObject({ ratio: null });
  });

  it("archives through the confirm dialog", async () => {
    const user = userEvent.setup();
    render(<CreativeManage creative={creative()} {...baseProps} />);
    await user.click(screen.getByRole("button", { name: /^archive$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^archive$/i }));
    await waitFor(() => expect(archiveMock).toHaveBeenCalledWith("image", "c1"));
  });

  it("shows Restore for an archived creative and calls restore", async () => {
    const user = userEvent.setup();
    render(
      <CreativeManage creative={creative({ deleted_at: "2026-05-22T00:00:00Z" })} {...baseProps} />,
    );
    // Edit is disabled while archived.
    expect(screen.getByRole("button", { name: /edit metadata/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /restore/i }));
    await waitFor(() => expect(restoreMock).toHaveBeenCalledWith("image", "c1"));
  });

  it("renders copy variants + the managed gate panels with a pipeline link", () => {
    render(
      <CreativeManage
        creative={creative()}
        {...baseProps}
        copyVariants={[
          {
            id: "cv1",
            platform: "meta",
            placement: "feed",
            headline: "Hi",
            body: "Body",
            status: "draft",
          },
        ]}
        qa={[{ id: "qa1", attempt: 1, status: "pass" }]}
        spec={[{ id: "sp1", platform: "meta", placement: "feed", status: "pass" }]}
        compliance={[{ id: "cf1", rule_id: "R1", verdict: "fail", overridden: true }]}
        stageState={[{ id: "ss1", stage: "qa", status: "cleared" }]}
      />,
    );
    expect(screen.getByText("Hi")).toBeInTheDocument();
    // The protected-artifact actions are delegated to ManagedGatePanels (image
    // surface, wired to the creative's pipeline).
    const panels = screen.getByTestId("managed-gate-panels");
    expect(panels).toHaveAttribute("data-creative", "c1");
    expect(panels).toHaveAttribute("data-pipeline", "pp1");
    expect(panels).toHaveAttribute("data-surface", "image");
    // The stage-state gate stays read-only on this page.
    expect(screen.getByText("qa")).toBeInTheDocument();
    // The pipeline-review link surfaces the full gate flow.
    const links = screen.getAllByRole("link", { name: /pipeline/i });
    expect(links.some((a) => a.getAttribute("href") === "/pipeline/pp1")).toBe(true);
  });

  it("passes a null pipeline through + no pipeline link when pipeline_id is null", () => {
    render(
      <CreativeManage
        creative={creative({ pipeline_id: null })}
        {...baseProps}
        brief={null}
        signedUrl={null}
        stageState={[]}
      />,
    );
    // No render placeholder.
    expect(screen.getByText(/No render yet/i)).toBeInTheDocument();
    // The managed panels receive a null pipeline (they self-disable the actions).
    expect(screen.getByTestId("managed-gate-panels")).toHaveAttribute("data-pipeline", "");
    // Stage-state empty state still renders on the page.
    expect(screen.getByText(/No gate state/i)).toBeInTheDocument();
    // No "Review in pipeline" link; the stage-state note has no pipeline link.
    expect(screen.queryByRole("link", { name: /review in pipeline/i })).not.toBeInTheDocument();
    expect(screen.getByText(/flow through the decision routes only/i)).toBeInTheDocument();
  });

  it("renders a bare copy variant + bare stage-state row (falsy optional fields)", () => {
    render(
      <CreativeManage
        creative={creative()}
        {...baseProps}
        copyVariants={[{ id: "cv0" }]}
        qa={[{ id: "qa0" }]}
        spec={[{ id: "sp0" }]}
        compliance={[{ id: "cf0" }]}
        stageState={[{ id: "ss0" }]}
      />,
    );
    // No headline/body/placement -> the dash fallbacks render; nothing throws.
    expect(screen.getByText("Copy variants (1)")).toBeInTheDocument();
    expect(screen.getByTestId("managed-gate-panels")).toBeInTheDocument();
  });

  it("surfaces an iterations load error", async () => {
    const { fetchCreativeIterations } = await import("@/lib/realtime/client-data");
    (fetchCreativeIterations as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("iter boom"),
    );
    render(<CreativeManage creative={creative()} {...baseProps} />);
    expect(await screen.findByText(/iter boom/i)).toBeInTheDocument();
  });

  it("toasts on a restore failure", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    restoreMock.mockRejectedValueOnce(new Error("restore boom"));
    render(
      <CreativeManage creative={creative({ deleted_at: "2026-05-22T00:00:00Z" })} {...baseProps} />,
    );
    await user.click(screen.getByRole("button", { name: /restore/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("restore boom"));
  });
});
