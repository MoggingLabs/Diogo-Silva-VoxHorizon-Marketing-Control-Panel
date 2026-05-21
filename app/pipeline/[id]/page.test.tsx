import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

const getPipeline = vi.fn();
vi.mock("@/lib/pipeline/client", () => ({
  getPipeline: (...args: unknown[]) => getPipeline(...args),
}));

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

// Stub all stage components so we don't need their full mocks.
vi.mock("@/components/pipeline/PipelineDetailRealtime", () => ({
  PipelineDetailRealtime: () => <div data-testid="realtime" />,
}));
vi.mock("@/components/pipeline/CancelPipelineButton", () => ({
  CancelPipelineButton: () => <button data-testid="cancel">cancel</button>,
}));
vi.mock("@/components/pipeline/HorizontalStepper", () => ({
  HorizontalStepper: ({ current }: { current: string }) => (
    <div data-testid="stepper" data-current={current} />
  ),
}));
vi.mock("@/components/pipeline/StageConfiguration", () => ({
  StageConfiguration: ({ clients }: { clients: unknown[] }) => (
    <div data-testid="stage" data-stage="configuration" data-clients={clients.length} />
  ),
}));
vi.mock("@/components/pipeline/StageIdeation", () => ({
  StageIdeation: () => <div data-testid="stage" data-stage="ideation" />,
}));
vi.mock("@/components/pipeline/StageReview", () => ({
  StageReview: () => <div data-testid="stage" data-stage="review" />,
}));
vi.mock("@/components/pipeline/StageGeneration", () => ({
  StageGeneration: () => <div data-testid="stage" data-stage="generation" />,
}));
vi.mock("@/components/pipeline/StageDone", () => ({
  StageDone: () => <div data-testid="stage" data-stage="done" />,
}));
vi.mock("@/components/pipeline/StagePlaceholder", () => ({
  StagePlaceholder: ({ stageLabel }: { stageLabel: string }) => (
    <div data-testid="placeholder" data-label={stageLabel} />
  ),
}));
// OperatorNarration uses the realtime hook; stub it so the server-component
// render doesn't open an SSE subscription.
vi.mock("@/components/pipeline/OperatorNarration", () => ({
  OperatorNarration: ({ pipelineId }: { pipelineId: string }) => (
    <div data-testid="operator-narration" data-pipeline={pipelineId} />
  ),
}));

const notFoundSpy = vi.fn(() => {
  throw new Error("__NOT_FOUND__");
});
vi.mock("next/navigation", () => ({
  notFound: () => notFoundSpy(),
}));

import PipelineDetailPage, { generateMetadata } from "./page";

function pipeline(over: Record<string, unknown>) {
  return {
    id: "abcd1234-rest",
    status: "configuration",
    format_choice: "image",
    client_id: "c1",
    image_brief_id: null,
    video_brief_id: null,
    config_draft: null,
    picks: null,
    cost_estimate: null,
    cost_actual: null,
    approval: null,
    launch_package_id: null,
    created_at: "2026-05-17",
    updated_at: "2026-05-17",
    advanced_at: null,
    ...over,
  };
}

describe("PipelineDetailPage", () => {
  it("renders configuration stage with clients list", async () => {
    getPipeline.mockResolvedValueOnce({ pipeline: pipeline({}), events: [] });
    currentSupabase = mockSupabaseClient({
      clients: {
        select: {
          single: { data: { name: "Acme" }, error: null },
          data: [{ id: "c1", name: "Acme", slug: "acme", service_type: "roofing" }],
          error: null,
        },
      },
    });
    const el = await PipelineDetailPage({ params: Promise.resolve({ id: "abcd1234-rest" }) });
    render(el);
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByTestId("stage")).toHaveAttribute("data-stage", "configuration");
  });

  it("shows the operator narration + a scoped spend-approvals link on active runs", async () => {
    getPipeline.mockResolvedValueOnce({
      pipeline: pipeline({ status: "ideation", id: "abcd1234-rest" }),
      events: [{ id: "e1" }],
    });
    currentSupabase = mockSupabaseClient();
    const el = await PipelineDetailPage({ params: Promise.resolve({ id: "abcd1234-rest" }) });
    render(el);
    expect(screen.getByTestId("operator-narration")).toHaveAttribute(
      "data-pipeline",
      "abcd1234-rest",
    );
    const approvalsLink = screen.getByRole("link", { name: /view spend approvals/i });
    expect(approvalsLink).toHaveAttribute("href", "/approvals?session=abcd1234-rest");
  });

  it("hides the supervision sidebar on a cancelled run", async () => {
    getPipeline.mockResolvedValueOnce({
      pipeline: pipeline({ status: "cancelled" }),
      events: [],
    });
    currentSupabase = mockSupabaseClient();
    const el = await PipelineDetailPage({ params: Promise.resolve({ id: "x" }) });
    render(el);
    // Cancelled pipelines render the placeholder branch but no narration sidebar.
    expect(screen.queryByTestId("operator-narration")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /view spend approvals/i })).not.toBeInTheDocument();
  });

  it("renders ideation stage", async () => {
    getPipeline.mockResolvedValueOnce({
      pipeline: pipeline({ status: "ideation" }),
      events: [],
    });
    currentSupabase = mockSupabaseClient({
      clients: { select: { data: null, error: null, single: { data: null, error: null } } },
    });
    const el = await PipelineDetailPage({ params: Promise.resolve({ id: "x" }) });
    render(el);
    expect(screen.getByTestId("stage")).toHaveAttribute("data-stage", "ideation");
  });

  it("renders review stage", async () => {
    getPipeline.mockResolvedValueOnce({
      pipeline: pipeline({ status: "review" }),
      events: [],
    });
    currentSupabase = mockSupabaseClient();
    const el = await PipelineDetailPage({ params: Promise.resolve({ id: "x" }) });
    render(el);
    expect(screen.getByTestId("stage")).toHaveAttribute("data-stage", "review");
  });

  it("renders generation stage with events", async () => {
    getPipeline.mockResolvedValueOnce({
      pipeline: pipeline({ status: "generation" }),
      events: [{ id: "e1" }],
    });
    currentSupabase = mockSupabaseClient();
    const el = await PipelineDetailPage({ params: Promise.resolve({ id: "x" }) });
    render(el);
    expect(screen.getByTestId("stage")).toHaveAttribute("data-stage", "generation");
  });

  it("renders done stage and hides cancel button", async () => {
    getPipeline.mockResolvedValueOnce({
      pipeline: pipeline({ status: "done" }),
      events: [],
    });
    currentSupabase = mockSupabaseClient();
    const el = await PipelineDetailPage({ params: Promise.resolve({ id: "x" }) });
    render(el);
    expect(screen.getByTestId("stage")).toHaveAttribute("data-stage", "done");
    expect(screen.queryByTestId("cancel")).not.toBeInTheDocument();
  });

  it("renders cancelled banner + placeholder", async () => {
    getPipeline.mockResolvedValueOnce({
      pipeline: pipeline({ status: "cancelled" }),
      events: [],
    });
    currentSupabase = mockSupabaseClient();
    const el = await PipelineDetailPage({ params: Promise.resolve({ id: "x" }) });
    render(el);
    expect(
      screen.getByText(/This pipeline was cancelled\. No further actions/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("placeholder")).toBeInTheDocument();
  });

  it("calls notFound on a 404", async () => {
    getPipeline.mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 404 }));
    await expect(PipelineDetailPage({ params: Promise.resolve({ id: "x" }) })).rejects.toThrow(
      "__NOT_FOUND__",
    );
  });

  it("rethrows non-404 errors", async () => {
    getPipeline.mockRejectedValueOnce(new Error("boom"));
    await expect(PipelineDetailPage({ params: Promise.resolve({ id: "x" }) })).rejects.toThrow(
      "boom",
    );
  });

  it("falls back to id slice when no client name and no client_id is null", async () => {
    getPipeline.mockResolvedValueOnce({
      pipeline: pipeline({ client_id: null, status: "ideation" }),
      events: [],
    });
    currentSupabase = mockSupabaseClient();
    const el = await PipelineDetailPage({ params: Promise.resolve({ id: "x" }) });
    render(el);
    expect(screen.getByRole("heading", { name: /unassigned client/i })).toBeInTheDocument();
  });

  it("uses client id slice when client_id set but lookup returns no name", async () => {
    getPipeline.mockResolvedValueOnce({
      pipeline: pipeline({ status: "ideation", client_id: "abcd1234-deadbeef" }),
      events: [],
    });
    currentSupabase = mockSupabaseClient({
      clients: { select: { data: null, error: null, single: { data: null, error: null } } },
    });
    const el = await PipelineDetailPage({ params: Promise.resolve({ id: "x" }) });
    render(el);
    expect(screen.getByRole("heading", { name: /abcd1234/i })).toBeInTheDocument();
  });

  it("generateMetadata returns truncated id", async () => {
    const m = await generateMetadata({ params: Promise.resolve({ id: "abcdef12-rest" }) });
    expect(m.title).toBe("Pipeline abcdef12 — VoxHorizon");
  });
});
