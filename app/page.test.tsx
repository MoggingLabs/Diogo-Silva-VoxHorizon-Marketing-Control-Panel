/**
 * Tests for the root dashboard page. Mocks the dashboard snapshot loader +
 * pipeline-lookup + client child components, then asserts on the rendered
 * tree from the server component.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const getDashboardSnapshot = vi.fn();
const findPipelinesForBriefs = vi.fn();

vi.mock("@/lib/dashboard", async () => ({
  getDashboardSnapshot: (...args: unknown[]) => getDashboardSnapshot(...args),
  parseFormat: (raw: string | undefined | null) =>
    raw === "image" || raw === "video" || raw === "both" ? raw : "both",
}));

vi.mock("@/lib/pipeline/lookup", () => ({
  findPipelinesForBriefs: (...args: unknown[]) => findPipelinesForBriefs(...args),
}));

vi.mock("@/components/funnel/FormatToggle", () => ({
  FormatToggle: ({ value }: { value: string }) => <div data-testid="toggle">{value}</div>,
}));

vi.mock("@/components/funnel/FunnelHeader", () => ({
  FunnelHeader: ({ format }: { format: string }) => <div data-testid="funnel">{format}</div>,
}));

vi.mock("@/components/kanban/KanbanBoard", () => ({
  KanbanBoard: ({
    format,
    imageBriefs,
    videoBriefs,
  }: {
    format: string;
    imageBriefs: { id: string }[];
    videoBriefs: { id: string }[];
  }) => (
    <div data-testid="kanban">
      <span data-testid="kanban-format">{format}</span>
      <span data-testid="kanban-image-count">{imageBriefs.length}</span>
      <span data-testid="kanban-video-count">{videoBriefs.length}</span>
    </div>
  ),
}));

import DashboardPage from "./page";

function snapshot(over: Partial<Record<string, unknown>> = {}) {
  return {
    format: over.format ?? "both",
    counts: {
      image: {
        in_brief: 1,
        in_creative: 0,
        in_copy: 0,
        in_launch: 0,
        live: 0,
        killed: 0,
      },
      video: {
        in_brief: 1,
        in_creative: 0,
        in_copy: 0,
        in_launch: 0,
        live: 0,
        killed: 0,
      },
      combined: {
        in_brief: 2,
        in_creative: 0,
        in_copy: 0,
        in_launch: 0,
        live: 0,
        killed: 0,
      },
    },
    image_briefs: over.image_briefs ?? [{ id: "b1" }],
    video_briefs: over.video_briefs ?? [{ id: "v1" }],
    errors: over.errors ?? {},
  };
}

describe("DashboardPage", () => {
  it("renders header + format toggle + funnel + kanban with SSR data", async () => {
    getDashboardSnapshot.mockResolvedValueOnce(snapshot());
    findPipelinesForBriefs.mockResolvedValueOnce({
      image: new Map([["b1", "p1"]]),
      video: new Map(),
    });

    const element = await DashboardPage({
      searchParams: Promise.resolve({ format: "both" }),
    });
    render(element);
    expect(screen.getByRole("heading", { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByTestId("toggle")).toHaveTextContent("both");
    expect(screen.getByTestId("kanban-image-count")).toHaveTextContent("1");
  });

  it("renders an alert when the snapshot has a single error", async () => {
    getDashboardSnapshot.mockResolvedValueOnce(snapshot({ errors: { image: "load failed" } }));
    findPipelinesForBriefs.mockResolvedValueOnce({ image: new Map(), video: new Map() });

    const element = await DashboardPage({ searchParams: Promise.resolve({}) });
    render(element);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Failed to load dashboard data: load failed/i,
    );
  });

  it("joins multiple errors with semicolons", async () => {
    getDashboardSnapshot.mockResolvedValueOnce(
      snapshot({ errors: { image: "img bad", video: "vid bad" } }),
    );
    findPipelinesForBriefs.mockResolvedValueOnce({ image: new Map(), video: new Map() });

    const element = await DashboardPage({ searchParams: Promise.resolve({}) });
    render(element);
    expect(screen.getByRole("alert")).toHaveTextContent(/img bad; vid bad/);
  });

  it("handles a string-array searchParam.format value", async () => {
    getDashboardSnapshot.mockResolvedValueOnce(snapshot({ format: "image" }));
    findPipelinesForBriefs.mockResolvedValueOnce({ image: new Map(), video: new Map() });

    const element = await DashboardPage({
      searchParams: Promise.resolve({ format: ["image", "ignored"] }),
    });
    render(element);
    expect(screen.getByTestId("toggle")).toHaveTextContent("image");
  });
});
