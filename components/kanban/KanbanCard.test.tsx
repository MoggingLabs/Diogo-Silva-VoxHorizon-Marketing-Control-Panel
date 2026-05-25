/**
 * Tests for the KanbanCard primitive.
 *
 * Covers:
 *   - Status pill mapping (each canonical status).
 *   - Unknown status fallback.
 *   - Image vs video kind badge.
 *   - Pipeline link override.
 *   - Standalone link target.
 *   - Client slug / name fallback.
 *   - `no client` fallback when client is null.
 *   - Relative time-since helper boundaries.
 *   - Handles invalid date string.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanCard } from "./KanbanCard";
import type { DashboardImageBrief, DashboardVideoBrief } from "@/lib/dashboard-types";

function img(over: Partial<DashboardImageBrief> = {}): DashboardImageBrief {
  return {
    id: "b1",
    brief_id_human: "BRF-001",
    status: "draft",
    created_at: "2026-05-17T11:00:00Z",
    posted_at: null,
    decided_at: null,
    client: { id: "c1", slug: "acme", name: "Acme Inc." },
    ...over,
  };
}

function vid(over: Partial<DashboardVideoBrief> = {}): DashboardVideoBrief {
  return {
    id: "v1",
    brief_id_human: "VBR-001",
    status: "draft",
    created_at: "2026-05-17T11:00:00Z",
    posted_at: null,
    decided_at: null,
    client: { id: "c1", slug: "acme", name: "Acme Inc." },
    ...over,
  };
}

const FIXED_NOW = new Date("2026-05-17T12:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXED_NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("KanbanCard", () => {
  it("renders the brief id and client slug", () => {
    render(<KanbanCard kind="image" brief={img()} />);

    expect(screen.getByText("BRF-001")).toBeInTheDocument();
    expect(screen.getByText("acme")).toBeInTheDocument();
  });

  it("renders the IMG badge for image briefs", () => {
    render(<KanbanCard kind="image" brief={img()} />);

    expect(screen.getByText("IMG")).toBeInTheDocument();
  });

  it("renders the VID badge for video briefs", () => {
    render(<KanbanCard kind="video" brief={vid()} />);

    expect(screen.getByText("VID")).toBeInTheDocument();
  });

  it("renders each known status pill label via the canonical StatusBadge", () => {
    const statuses = ["draft", "posted", "approved", "approved_with_changes", "rejected"] as const;
    for (const status of statuses) {
      const { unmount } = render(<KanbanCard kind="image" brief={img({ status })} />);
      // `approved_with_changes` keeps its short card label; the rest use the
      // StatusBadge's humanized label.
      const labelMap: Record<string, string> = {
        draft: "Draft",
        posted: "Posted",
        approved: "Approved",
        approved_with_changes: "Approved w/ changes",
        rejected: "Rejected",
      };
      expect(screen.getByText(labelMap[status]!)).toBeInTheDocument();
      unmount();
    }
  });

  it("humanizes an unknown status through the StatusBadge fallback", () => {
    render(<KanbanCard kind="image" brief={img({ status: "exotic-status" as never })} />);

    expect(screen.getByText("Exotic status")).toBeInTheDocument();
  });

  it("links to /pipeline/[id] when pipelineId is provided", () => {
    render(<KanbanCard kind="image" brief={img()} pipelineId="pipe-42" />);

    expect(screen.getByRole("link")).toHaveAttribute("href", "/pipeline/pipe-42");
  });

  it("links to /briefs/[id] for image kind without a pipelineId", () => {
    render(<KanbanCard kind="image" brief={img()} />);

    expect(screen.getByRole("link")).toHaveAttribute("href", "/briefs/b1");
  });

  it("links to /briefs/video/[id] for video kind without a pipelineId", () => {
    render(<KanbanCard kind="video" brief={vid()} />);

    expect(screen.getByRole("link")).toHaveAttribute("href", "/briefs/video/v1");
  });

  it('renders "no client" when client is null', () => {
    render(<KanbanCard kind="image" brief={img({ client: null })} />);

    expect(screen.getByText("no client")).toBeInTheDocument();
  });

  it("falls back to client name when slug is null (via nullish coalescing)", () => {
    render(
      <KanbanCard
        kind="image"
        brief={img({
          client: { id: "c1", slug: null as unknown as string, name: "Only Name" },
        })}
      />,
    );

    expect(screen.getByText("Only Name")).toBeInTheDocument();
  });

  it('renders "just now" when created less than a minute ago', () => {
    const justAfter = new Date(FIXED_NOW - 30_000).toISOString();
    render(<KanbanCard kind="image" brief={img({ created_at: justAfter })} />);

    expect(screen.getByText("just now")).toBeInTheDocument();
  });

  it("renders minutes for sub-hour age", () => {
    const fifteen = new Date(FIXED_NOW - 15 * 60_000).toISOString();
    render(<KanbanCard kind="image" brief={img({ created_at: fifteen })} />);

    expect(screen.getByText("15m ago")).toBeInTheDocument();
  });

  it("renders hours for sub-day age", () => {
    const twoH = new Date(FIXED_NOW - 2 * 3600_000).toISOString();
    render(<KanbanCard kind="image" brief={img({ created_at: twoH })} />);

    expect(screen.getByText("2h ago")).toBeInTheDocument();
  });

  it("renders days for sub-month age", () => {
    const threeD = new Date(FIXED_NOW - 3 * 86400_000).toISOString();
    render(<KanbanCard kind="image" brief={img({ created_at: threeD })} />);

    expect(screen.getByText("3d ago")).toBeInTheDocument();
  });

  it("renders months for >=30d age", () => {
    const sixtyD = new Date(FIXED_NOW - 60 * 86400_000).toISOString();
    render(<KanbanCard kind="image" brief={img({ created_at: sixtyD })} />);

    expect(screen.getByText("2mo ago")).toBeInTheDocument();
  });

  it('renders "just now" when created_at is in the future', () => {
    const tomorrow = new Date(FIXED_NOW + 86400_000).toISOString();
    render(<KanbanCard kind="image" brief={img({ created_at: tomorrow })} />);

    expect(screen.getByText("just now")).toBeInTheDocument();
  });

  it("renders an em-dash when created_at is not a valid date string", () => {
    render(<KanbanCard kind="image" brief={img({ created_at: "not-a-date" })} />);

    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
