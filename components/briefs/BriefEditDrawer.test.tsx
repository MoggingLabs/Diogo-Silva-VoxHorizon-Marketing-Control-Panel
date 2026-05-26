/**
 * Tests for the image-brief edit drawer (E3.2 / #591).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const updateImageBrief = vi.fn();
vi.mock("@/lib/briefs-client", () => ({
  updateImageBrief: (id: string, body: unknown) => updateImageBrief(id, body),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { BriefEditDrawer } from "./BriefEditDrawer";
import type { Brief } from "@/lib/briefs";

function makeBrief(over: Partial<Brief> = {}): Brief {
  return {
    id: "b1",
    brief_id_human: "img-1",
    client_id: "c1",
    status: "draft",
    payload: {
      service: "roofing",
      budget: 5000,
      market: "Austin",
      angles: ["a1"],
      targeting: { radius_km: 25 },
    },
    created_at: "2026-05-20T00:00:00Z",
    posted_at: null,
    decided_at: null,
    decided_by: null,
    decided_notes: null,
    deleted_at: null,
    ...over,
  } as Brief;
}

afterEach(() => vi.clearAllMocks());

describe("BriefEditDrawer", () => {
  it("prefills payload fields from the brief", () => {
    render(<BriefEditDrawer open onOpenChange={vi.fn()} brief={makeBrief()} />);
    expect(screen.getByLabelText(/market/i)).toHaveValue("Austin");
    expect(screen.getByLabelText(/total budget/i)).toHaveValue("5000");
  });

  it("submits a rebuilt payload preserving untouched fields, omitting status when unchanged", async () => {
    const user = userEvent.setup();
    render(<BriefEditDrawer open onOpenChange={vi.fn()} brief={makeBrief()} />);

    const market = screen.getByLabelText(/market/i);
    await user.clear(market);
    await user.type(market, "Dallas, TX");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateImageBrief).toHaveBeenCalled());
    const [id, body] = updateImageBrief.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe("b1");
    const payload = body.payload as Record<string, unknown>;
    expect(payload.market).toBe("Dallas, TX");
    // Untouched fields are preserved (not dropped on edit).
    expect(payload.angles).toEqual(["a1"]);
    expect(payload.targeting).toEqual({ radius_km: 25 });
    // Status unchanged → not sent.
    expect(body.status).toBeUndefined();
  });

  it("fills every optional payload field + a status change, sending both payload and status", async () => {
    const user = userEvent.setup();
    // Start from a posted brief so a draft transition is legal + selectable.
    render(
      <BriefEditDrawer
        open
        onOpenChange={vi.fn()}
        brief={makeBrief({
          status: "posted",
          payload: { service: "roofing", budget: 1000, market: "Austin" },
        })}
      />,
    );

    await user.type(screen.getByLabelText(/daily budget/i), "250");
    await user.type(screen.getByLabelText(/landing page url/i), "https://lp.example.com");
    await user.type(screen.getByLabelText(/offer text/i), "Free quote");
    await user.type(screen.getByLabelText(/^notes$/i), "rush this");

    // Change status posted -> draft (an allowed transition).
    const triggers = screen.getAllByRole("combobox");
    const statusTrigger = triggers.at(-1);
    if (!statusTrigger) throw new Error("status select not found");
    await user.click(statusTrigger);
    await user.click(await screen.findByRole("option", { name: "Draft" }));

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateImageBrief).toHaveBeenCalled());
    const [, body] = updateImageBrief.mock.calls[0] as [string, Record<string, unknown>];
    const payload = body.payload as Record<string, unknown>;
    expect(payload.budget_daily).toBe(250);
    expect(payload.landing_page_url).toBe("https://lp.example.com");
    expect(payload.offer_text).toBe("Free quote");
    expect(payload.notes).toBe("rush this");
    expect(body.status).toBe("draft");
  });

  it("only offers status transitions the state machine allows from draft", async () => {
    const user = userEvent.setup();
    render(<BriefEditDrawer open onOpenChange={vi.fn()} brief={makeBrief({ status: "draft" })} />);
    // Open the status select (last combobox = status; service is first).
    const triggers = screen.getAllByRole("combobox");
    const statusTrigger = triggers.at(-1);
    if (!statusTrigger) throw new Error("status select not found");
    await user.click(statusTrigger);
    const listbox = await screen.findByRole("listbox");
    // From draft, only draft + posted are valid.
    expect(within(listbox).getByRole("option", { name: "Draft" })).toBeInTheDocument();
    expect(within(listbox).getByRole("option", { name: "Posted" })).toBeInTheDocument();
    expect(within(listbox).queryByRole("option", { name: "Approved" })).not.toBeInTheDocument();
  });
});
