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
import type { Brief } from "@/lib/briefs";
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
    deleted_at: null,
    ...over,
  };
}

// A canonical `briefs` row in the concepts-first shape the operator actually
// authors (NO top-level offer_text/angles/extras; the value is per-concept).
function makeImageBrief(payload?: Brief["payload"]): Brief {
  return {
    id: "brief-1",
    brief_id_human: "ACME-0001",
    client_id: "c1",
    created_at: "2026-05-17T10:00:00Z",
    decided_at: null,
    decided_by: null,
    decided_notes: null,
    deleted_at: null,
    posted_at: null,
    status: "posted",
    payload: payload ?? {
      market: "Austin, TX",
      service: "roofing",
      service_type: "roofing",
      audience: "homeowners 35-65, post-storm",
      ad_count: 4,
      budget: 5000,
      client_name: "Acme Roofing",
      client_slug: "acme-roofing",
      manager_review_request: "Confirm the $99 inspection offer reads compliant.",
      render_model: "flux",
      render_backend: "kie",
      global_negative_constraints: ["guaranteed approval", "lowest price in town"],
      format_instructions: { "1x1": "Centered hero, headline top." },
      concepts: [
        {
          concept_name: "Storm-ready trust",
          prompt: "Warm golden-hour shot of a roofer on a charcoal shingle roof.",
          use_case: "Top-of-funnel awareness",
          qa_notes: "Avoid visible brand logos.",
          best_paired_offer: "$99 roof inspection",
          concept_key: "storm_ready_trust",
        },
        {
          concept_name: "Owner-led savings",
          prompt: "Family-owned roofer shaking hands with a homeowner.",
          use_case: "Retargeting",
          qa_notes: "Real owner on-site, no stock feel.",
          best_paired_offer: "0% financing for 24 months",
          concept_key: "owner_led_savings",
        },
      ],
    },
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

describe("OperatorBriefReview - canonical briefs row (concepts-first)", () => {
  it("renders market / audience / service from the briefs row", () => {
    render(<OperatorBriefReview pipeline={makePipeline()} imageBrief={makeImageBrief()} />);
    expect(screen.getByText("Austin, TX")).toBeInTheDocument();
    expect(screen.getByText("homeowners 35-65, post-storm")).toBeInTheDocument();
    expect(screen.getByText("roofing")).toBeInTheDocument();
    expect(screen.getByText("Acme Roofing")).toBeInTheDocument();
  });

  it("renders each concept with its prompt, use case, offer, and QA notes", () => {
    render(<OperatorBriefReview pipeline={makePipeline()} imageBrief={makeImageBrief()} />);
    expect(screen.getByText("Storm-ready trust")).toBeInTheDocument();
    expect(screen.getByText("Owner-led savings")).toBeInTheDocument();
    expect(screen.getByText(/Warm golden-hour shot of a roofer/)).toBeInTheDocument();
    expect(screen.getByText("Top-of-funnel awareness")).toBeInTheDocument();
    expect(screen.getByText("$99 roof inspection")).toBeInTheDocument();
    expect(screen.getByText("Avoid visible brand logos.")).toBeInTheDocument();
  });

  it("renders the global negative constraints, format instructions, and review request", () => {
    render(<OperatorBriefReview pipeline={makePipeline()} imageBrief={makeImageBrief()} />);
    const block = screen.getByLabelText("Global negative constraints");
    expect(block).toBeInTheDocument();
    expect(screen.getByText("guaranteed approval")).toBeInTheDocument();
    expect(screen.getByText("1x1")).toBeInTheDocument();
    expect(screen.getByText("Centered hero, headline top.")).toBeInTheDocument();
    expect(
      screen.getByText(/Confirm the \$99 inspection offer reads compliant\./),
    ).toBeInTheDocument();
  });

  it("does NOT render the config_draft offer fallback when a briefs row is present", () => {
    render(<OperatorBriefReview pipeline={makePipeline()} imageBrief={makeImageBrief()} />);
    // The config_draft.image_payload offer ("$99 roof inspection" in the
    // fallback) is suppressed; the offer label section is not rendered.
    expect(screen.queryByText("Offer")).not.toBeInTheDocument();
    // The manager's instruction (from config_draft) still renders.
    expect(screen.getByText(/4 roofing ads, Austin, \$99 inspection/)).toBeInTheDocument();
  });

  it("falls back to the config_draft.image_payload render when there is NO briefs row", () => {
    render(<OperatorBriefReview pipeline={makePipeline()} imageBrief={null} />);
    // Fallback offer section renders from config_draft.image_payload.
    expect(screen.getByText("Offer")).toBeInTheDocument();
    expect(screen.getByText("before_after")).toBeInTheDocument();
    // The concepts view's compliance block is absent in the fallback.
    expect(screen.queryByLabelText("Global negative constraints")).not.toBeInTheDocument();
  });

  it("degrades gracefully when the briefs row has no concepts", () => {
    render(
      <OperatorBriefReview
        pipeline={makePipeline()}
        imageBrief={makeImageBrief({ market: "Tampa", concepts: [] })}
      />,
    );
    expect(screen.getByText("Tampa")).toBeInTheDocument();
    expect(screen.getByText(/No concepts authored yet\./)).toBeInTheDocument();
  });

  it("renders a placeholder concept name and skips empty fields defensively", () => {
    render(
      <OperatorBriefReview
        pipeline={makePipeline()}
        imageBrief={makeImageBrief({
          market: "Reno",
          // A concept with no name / prompt / offer / use_case / qa_notes and
          // no concept_key (exercises the index-key + placeholder fallbacks),
          // plus a non-object entry that the filter drops.
          concepts: [{}, null, "junk"],
          // Non-string format-instruction values are dropped; an array payload
          // for format_instructions is ignored entirely.
          format_instructions: { "1x1": 42, "9x16": "Tall hero." },
          global_negative_constraints: [],
        })}
      />,
    );
    expect(screen.getByText("Reno")).toBeInTheDocument();
    expect(screen.getByText("Untitled concept")).toBeInTheDocument();
    // The numeric format value is dropped; only the string one renders.
    expect(screen.getByText("Tall hero.")).toBeInTheDocument();
    expect(screen.queryByText("42")).not.toBeInTheDocument();
    // No negative-constraints block when the list is empty.
    expect(screen.queryByLabelText("Global negative constraints")).not.toBeInTheDocument();
  });

  it("ignores a non-object briefs payload and falls back to config_draft", () => {
    render(<OperatorBriefReview pipeline={makePipeline()} imageBrief={makeImageBrief([])} />);
    // An array payload is not the concepts-first object shape -> fallback.
    expect(screen.getByText("Offer")).toBeInTheDocument();
  });

  it("still approves via /advance when rendering from the briefs row", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const user = userEvent.setup();
    render(<OperatorBriefReview pipeline={makePipeline()} imageBrief={makeImageBrief()} />);
    await user.click(screen.getByRole("button", { name: /Approve brief/i }));
    await waitFor(() => {
      expect(routerRefresh).toHaveBeenCalled();
    });
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
