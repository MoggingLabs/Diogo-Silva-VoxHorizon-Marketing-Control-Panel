/**
 * Tests for the image brief form.
 *
 * The form:
 *   - Fetches active clients from supabase on mount.
 *   - Validates required fields client-side (client_id, market, budget).
 *   - Builds a typed `BriefPayloadT` via `toPayload(values)` and round-trips
 *     through zod before POSTing.
 *   - Has two submit modes: save draft (POST /api/briefs) and post-for-approval
 *     (POST /api/briefs?post=1).
 *   - Redirects to /briefs/[id] on success.
 *   - Surfaces server-side issue messages onto the matching field errors.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spyOnFetch, jsonResponse } from "@/tests/unit/helpers/worker-mock";
import type { ClientOption } from "@/lib/realtime/client-data";

// Radix Select uses ResizeObserver, which jsdom doesn't provide. Polyfill it
// here so the component can mount cleanly in tests.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// PointerEvent.hasPointerCapture is also not implemented in jsdom and Radix
// Select calls it. Patch it on the prototype so it returns false.
if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}
if (!HTMLElement.prototype.releasePointerCapture) {
  HTMLElement.prototype.releasePointerCapture = () => {};
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

// Clients are fetched via the service-role API route (client-data helper).
const fetchClients = vi.fn<() => Promise<ClientOption[]>>(async () => []);
vi.mock("@/lib/realtime/client-data", () => ({
  fetchClients: () => fetchClients(),
}));

import { BriefForm } from "./BriefForm";

beforeEach(() => {
  push.mockReset();
  fetchClients.mockReset();
  fetchClients.mockResolvedValue([
    { id: "c1", name: "Acme Roofing", slug: "acme", service_type: "roofing" },
    { id: "c2", name: "Beta Remodel", slug: "beta", service_type: "remodeling" },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BriefForm", () => {
  it("renders the field labels and Save Draft / Post buttons", async () => {
    render(<BriefForm />);

    expect(screen.getByLabelText("Client")).toBeInTheDocument();
    expect(screen.getByLabelText(/Market/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Total budget/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save draft/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Post for approval/ })).toBeInTheDocument();
  });

  it("shows the 'pick a client' error when submitting with no client selected", async () => {
    render(<BriefForm />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    await screen.findByText(/Pick a client/);
  });

  it("validates that market is required", async () => {
    render(<BriefForm initialClientId="c1" />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Save draft/ }));
    await screen.findByText(/Market is required/);
  });

  it("validates that budget is required", async () => {
    render(<BriefForm initialClientId="c1" />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Market/), "Tampa");
    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    await screen.findByText(/Budget is required/);
  });

  it("posts the payload and routes to /briefs/[id] on a successful draft save", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ brief: { id: "new-id" } })));

    render(<BriefForm initialClientId="c1" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Market/), "Tampa");
    await user.type(screen.getByLabelText(/Total budget/), "5000");
    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/briefs/new-id"));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/briefs",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("appends ?post=1 to the URL on Post for approval", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ brief: { id: "n2" } })));

    render(<BriefForm initialClientId="c1" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Market/), "Tampa");
    await user.type(screen.getByLabelText(/Total budget/), "5000");
    await user.click(screen.getByRole("button", { name: /Post for approval/ }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/briefs?post=1");
  });

  it("surfaces server-side issues onto the matching field error", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: "validation failed",
            issues: [{ message: "Market too short", path: ["market"] }],
          },
          { status: 422 },
        ),
      ),
    );

    render(<BriefForm initialClientId="c1" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Market/), "Tampa");
    await user.type(screen.getByLabelText(/Total budget/), "5000");
    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    expect(await screen.findByText("Market too short")).toBeInTheDocument();
  });

  it("surfaces the server error message even when issues array is missing", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: "boom" }, { status: 500 })),
    );

    render(<BriefForm initialClientId="c1" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Market/), "Tampa");
    await user.type(screen.getByLabelText(/Total budget/), "5000");
    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });

  it("falls back to `Request failed (status)` when error body is unparseable", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(new Response("not-json", { status: 503 })),
    );

    render(<BriefForm initialClientId="c1" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Market/), "Tampa");
    await user.type(screen.getByLabelText(/Total budget/), "5000");
    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    expect(await screen.findByText(/Request failed \(503\)/)).toBeInTheDocument();
  });

  it("propagates a client load error into a banner", async () => {
    fetchClients.mockRejectedValue(new Error("boom from supabase"));

    render(<BriefForm />);
    expect(await screen.findByText(/boom from supabase/)).toBeInTheDocument();
  });

  it("prevents the default form submit (Enter key)", async () => {
    const fetchSpy = spyOnFetch();
    render(<BriefForm initialClientId="c1" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Market/), "Tampa");
    // Press Enter inside the market input to trigger native form submit.
    await user.type(screen.getByLabelText(/Market/), "{enter}");

    // No fetch is made — onSubmit only calls preventDefault.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the clients dropdown when clients load successfully", async () => {
    render(<BriefForm initialClientId="c1" />);

    // Wait for the loading text to clear and the form to render with clients.
    await waitFor(() => {
      expect(screen.getByLabelText("Client")).not.toBeDisabled();
    });
  });

  it("renders 'No active clients found' when the clients list comes back empty", async () => {
    fetchClients.mockResolvedValue([]);

    render(<BriefForm />);

    // The placeholder text appears inside the SelectValue of the disabled trigger.
    expect(await screen.findByText(/No active clients found/)).toBeInTheDocument();
  });

  it("surfaces per-field server issues for budget_daily, age_max, and landing_page_url", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: "validation failed",
            issues: [
              { message: "daily budget too high", path: ["budget_daily"] },
              { message: "age max out of bounds", path: ["age_max"] },
              { message: "URL invalid", path: ["landing_page_url"] },
            ],
          },
          { status: 422 },
        ),
      ),
    );

    render(<BriefForm initialClientId="c1" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Market/), "Tampa");
    await user.type(screen.getByLabelText(/Total budget/), "5000");
    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    expect(await screen.findByText("daily budget too high")).toBeInTheDocument();
    expect(screen.getByText("age max out of bounds")).toBeInTheDocument();
    expect(screen.getByText("URL invalid")).toBeInTheDocument();
  });

  it("ignores server issues whose path key isn't a known field", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: "validation failed",
            issues: [{ message: "bogus field error", path: ["some_unknown_key"] }],
          },
          { status: 422 },
        ),
      ),
    );

    render(<BriefForm initialClientId="c1" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Market/), "Tampa");
    await user.type(screen.getByLabelText(/Total budget/), "5000");
    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    // The unknown-path issue isn't routed to a field, but the global
    // submitError is set from data.error.
    expect(await screen.findByText(/validation failed/)).toBeInTheDocument();
    expect(screen.queryByText("bogus field error")).not.toBeInTheDocument();
  });

  it("encodes targeting / angles / offer_text / notes / landing_page_url into the payload", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ brief: { id: "new-id" } })));

    render(<BriefForm initialClientId="c1" />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Market/), "Tampa");
    await user.type(screen.getByLabelText(/Total budget/), "5000");
    await user.type(screen.getByLabelText(/Daily budget/), "100");
    await user.type(screen.getByLabelText(/Landing page URL/), "https://lp.example.com");
    await user.type(screen.getByLabelText(/Radius/), "10");
    await user.type(screen.getByLabelText(/ZIPs/), "33601, 33602");
    await user.type(screen.getByLabelText(/Age min/), "30");
    await user.type(screen.getByLabelText(/Age max/), "60");
    await user.type(screen.getByLabelText(/Angles/), "headline 1\nheadline 2");
    await user.type(screen.getByLabelText(/Offer/), "Limited offer");
    await user.type(screen.getByLabelText(/Internal notes/), "internal notes line");

    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string) as {
      payload: {
        targeting?: {
          radius_km?: number;
          zips?: string[];
          age_min?: number;
          age_max?: number;
        };
        angles?: string[];
        offer_text?: string;
        notes?: string;
        landing_page_url?: string;
        budget_daily?: number;
      };
    };
    expect(body.payload.targeting?.radius_km).toBe(10);
    expect(body.payload.targeting?.zips).toEqual(["33601", "33602"]);
    expect(body.payload.targeting?.age_min).toBe(30);
    expect(body.payload.targeting?.age_max).toBe(60);
    expect(body.payload.angles).toEqual(["headline 1", "headline 2"]);
    expect(body.payload.offer_text).toBe("Limited offer");
    expect(body.payload.notes).toBe("internal notes line");
    expect(body.payload.landing_page_url).toBe("https://lp.example.com");
    expect(body.payload.budget_daily).toBe(100);
  });

  it("does not POST when the typed payload fails zod refinement", async () => {
    const fetchSpy = spyOnFetch();
    render(<BriefForm initialClientId="c1" />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Market/), "Tampa");
    await user.type(screen.getByLabelText(/Total budget/), "-50");
    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    await waitFor(() => {
      // No HTTP call is made when the local zod re-validation fails.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
