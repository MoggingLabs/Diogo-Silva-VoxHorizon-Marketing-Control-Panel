/**
 * OperatorBriefReview is the configuration-gate panel for operator-driven
 * pipelines: the manager reviews the brief the operator authored and approves
 * it (which POSTs the existing /advance endpoint to re-dispatch the operator
 * for concepts).
 *
 * Tests cover:
 *  - Rendering the authored brief: instruction, offer, must_avoid (do-not-say),
 *    angles, proof points, approve button.
 *  - The approve action POSTing to /advance + router.refresh on success.
 *  - The advance error path.
 *  - The collapsible operator-reasoning block.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";
import type { Pipeline } from "@/lib/pipeline/types";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { OperatorBriefReview } from "./OperatorBriefReview";

function makePipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p1",
    status: "configuration",
    format_choice: "image",
    client_id: "c1",
    image_brief_id: "brief-1",
    video_brief_id: null,
    config_draft: {
      operator_driven: true,
      operator_instruction: "4 roofing ads, Austin, $99 inspection",
      notes: "Sharpened the offer to a concrete $99 inspection.",
      image_payload: {
        service: "roofing",
        offer_text: "$99 roof inspection",
        market: "Austin, TX",
        audience: "homeowners 35-65, post-storm",
        angles: ["before_after", "owner_led_trust", "savings"],
        extras: {
          brand_tone: "trustworthy, premium but approachable",
          must_avoid: ["guaranteed approval", "lowest price in town"],
          proof_points: ["Family-owned since 2009", "4.9 stars on 700+ reviews"],
          secondary_offers: ["0% financing for 24 months"],
          creative_direction: "warm golden-hour, real owner on-site",
          location_notes: "Austin suburbs, charcoal architectural shingles",
          client_name: "Acme Roofing",
        },
      },
    },
    picks: null,
    cost_estimate: null,
    cost_actual: null,
    approval: null,
    launch_package_id: null,
    created_at: "2026-05-17T10:00:00Z",
    updated_at: "2026-05-17T10:00:00Z",
    advanced_at: null,
    ...over,
  };
}

beforeEach(() => {
  routerRefresh.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OperatorBriefReview - rendering", () => {
  it("renders the manager's instruction and the offer prominently", () => {
    render(<OperatorBriefReview pipeline={makePipeline()} />);
    expect(screen.getByText(/4 roofing ads, Austin, \$99 inspection/)).toBeInTheDocument();
    expect(screen.getByText("$99 roof inspection")).toBeInTheDocument();
  });

  it("renders market, audience, and angle badges", () => {
    render(<OperatorBriefReview pipeline={makePipeline()} />);
    expect(screen.getByText("Austin, TX")).toBeInTheDocument();
    expect(screen.getByText("homeowners 35-65, post-storm")).toBeInTheDocument();
    expect(screen.getByText("before_after")).toBeInTheDocument();
    expect(screen.getByText("owner_led_trust")).toBeInTheDocument();
  });

  it("renders the do-not-say / must_avoid rules in a distinct compliance block", () => {
    render(<OperatorBriefReview pipeline={makePipeline()} />);
    const block = screen.getByLabelText("Do-not-say rules");
    expect(block).toBeInTheDocument();
    expect(screen.getByText("guaranteed approval")).toBeInTheDocument();
    expect(screen.getByText("lowest price in town")).toBeInTheDocument();
    expect(screen.getByText(/Do not say/i)).toBeInTheDocument();
  });

  it("renders proof points and secondary offers", () => {
    render(<OperatorBriefReview pipeline={makePipeline()} />);
    expect(screen.getByText("Family-owned since 2009")).toBeInTheDocument();
    expect(screen.getByText("0% financing for 24 months")).toBeInTheDocument();
  });

  it("renders the approve button", () => {
    render(<OperatorBriefReview pipeline={makePipeline()} />);
    expect(
      screen.getByRole("button", { name: /Approve brief — continue to concepts/i }),
    ).toBeInTheDocument();
  });

  it("shows the operator's reasoning in a collapsible block (collapsed by default)", async () => {
    const user = userEvent.setup();
    render(<OperatorBriefReview pipeline={makePipeline()} />);
    // Collapsed: the reasoning text isn't shown yet.
    expect(screen.queryByText(/Sharpened the offer to a concrete/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Operator's reasoning/i }));
    expect(screen.getByText(/Sharpened the offer to a concrete/)).toBeInTheDocument();
  });

  it("degrades gracefully when extras are missing", () => {
    render(
      <OperatorBriefReview
        pipeline={makePipeline({
          config_draft: {
            operator_driven: true,
            image_payload: { offer_text: "$49 tune-up", market: "Tampa" },
          },
        })}
      />,
    );
    expect(screen.getByText("$49 tune-up")).toBeInTheDocument();
    // No compliance block when must_avoid is absent.
    expect(screen.queryByLabelText("Do-not-say rules")).not.toBeInTheDocument();
  });
});

describe("OperatorBriefReview - approve action", () => {
  it("POSTs to /advance and refreshes on success", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const user = userEvent.setup();
    render(<OperatorBriefReview pipeline={makePipeline()} />);

    await user.click(screen.getByRole("button", { name: /Approve brief — continue to concepts/i }));

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/pipelines/p1/advance") &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(routerRefresh).toHaveBeenCalled();
    });
  });

  it("surfaces an error when the advance fails", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "client_id missing" }, { status: 422 }));
    const user = userEvent.setup();
    render(<OperatorBriefReview pipeline={makePipeline()} />);

    await user.click(screen.getByRole("button", { name: /Approve brief — continue to concepts/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/client_id missing/);
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
