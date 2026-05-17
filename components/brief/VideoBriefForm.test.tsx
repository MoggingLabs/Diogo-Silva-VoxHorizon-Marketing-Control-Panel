/**
 * Tests for the video brief form.
 *
 * Covers:
 *   - Renders default segment and shows the "Sum / target" mismatch indicator.
 *   - Adding a segment expands the field array.
 *   - Removing a segment is disabled when only one segment remains.
 *   - Save draft POSTs `/api/briefs/video` without `?post=1`.
 *   - Post for approval POSTs `/api/briefs/video?post=1`.
 *   - Redirects on a successful submit.
 *   - Surfaces API error body.
 *   - Surfaces fallback "Request failed" when body is non-JSON.
 *   - String exceptions go through String() coercion.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spyOnFetch, jsonResponse } from "@/tests/unit/helpers/worker-mock";

// Radix Select uses ResizeObserver, which jsdom doesn't provide.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
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
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), back: vi.fn() }),
}));

import { VideoBriefForm } from "./VideoBriefForm";

const CLIENT_C1_ID = "a1b2c3d4-e5f6-4789-abcd-ef0123456789";
const CLIENT_C2_ID = "f1e2d3c4-b5a6-4987-9876-543210fedcba";
const CLIENTS = [
  { id: CLIENT_C1_ID, name: "Acme", slug: "acme" },
  { id: CLIENT_C2_ID, name: "Beta", slug: "beta" },
];

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Defaults that pre-fill a valid-by-default form for submit tests. */
const VALID_DEFAULTS = {
  client_id: CLIENT_C1_ID,
  target_duration_s: 15,
};

/**
 * Fill the minimum set of fields that satisfy zod validation for a
 * single-segment video brief: hook ≥5 chars, voice_id ≥2 chars, segment
 * topic ≥2 chars, and segment duration_s matches target_duration_s.
 *
 * Default render uses target=30 + segment=15 (mismatch). The submit tests
 * pass `defaults={VALID_DEFAULTS}` so target starts at 15s — matching the
 * single 15s segment that's seeded.
 */
async function fillRequired(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Topic"), "intro");
  await user.type(screen.getByLabelText("Voice ID"), "voice-abc");
  await user.type(screen.getByLabelText("Hook"), "Stop scrolling now");
}

describe("VideoBriefForm", () => {
  it("renders Save Draft + Post for approval and a default segment", () => {
    render(<VideoBriefForm clients={CLIENTS} />);

    expect(screen.getByRole("button", { name: /Save draft/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Post for approval/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Topic")).toBeInTheDocument();
    expect(screen.getByLabelText("Duration (s)")).toBeInTheDocument();
  });

  it("renders the segment-duration mismatch hint when the sum differs from target", () => {
    render(<VideoBriefForm clients={CLIENTS} />);

    // Default segment duration is 15s, default target 30s — mismatch.
    expect(screen.getByText("mismatch")).toBeInTheDocument();
    expect(screen.getByText(/Sum:/)).toBeInTheDocument();
  });

  it("adds a segment when 'Add segment' is clicked", async () => {
    render(<VideoBriefForm clients={CLIENTS} />);
    const user = userEvent.setup();

    expect(screen.getAllByLabelText("Topic")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /Add segment/ }));
    expect(screen.getAllByLabelText("Topic")).toHaveLength(2);
  });

  it("disables Remove when only a single segment remains", () => {
    render(<VideoBriefForm clients={CLIENTS} />);

    const removeButton = screen.getByRole("button", { name: /Remove/ });
    expect(removeButton).toBeDisabled();
  });

  it("enables Remove once there are 2+ segments", async () => {
    render(<VideoBriefForm clients={CLIENTS} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Add segment/ }));
    const removeButtons = screen.getAllByRole("button", { name: /Remove/ });
    expect(removeButtons[0]).toBeEnabled();
    expect(removeButtons[1]).toBeEnabled();
  });

  it("clicks Remove and shrinks the array back to one segment", async () => {
    render(<VideoBriefForm clients={CLIENTS} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Add segment/ }));
    expect(screen.getAllByLabelText("Topic")).toHaveLength(2);

    const removeButtons = screen.getAllByRole("button", { name: /Remove/ });
    await user.click(removeButtons[0]!);

    expect(screen.getAllByLabelText("Topic")).toHaveLength(1);
  });

  it("posts the payload as a draft on Save Draft and routes to the detail page", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ id: "new-id" })));

    render(<VideoBriefForm clients={CLIENTS} defaults={VALID_DEFAULTS} />);
    const user = userEvent.setup();

    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/briefs/video");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/briefs/video/new-id"));
  });

  it("appends ?post=1 on Post for approval", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ id: "new-id" })));

    render(<VideoBriefForm clients={CLIENTS} defaults={VALID_DEFAULTS} />);
    const user = userEvent.setup();

    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Post for approval/ }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/briefs/video?post=1");
  });

  it("surfaces an API error message on failure", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: "validation failed" }, { status: 422 })),
    );

    render(<VideoBriefForm clients={CLIENTS} defaults={VALID_DEFAULTS} />);
    const user = userEvent.setup();
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    expect(await screen.findByText(/validation failed/)).toBeInTheDocument();
  });

  it("falls back to 'Request failed (status)' on non-JSON error body", async () => {
    spyOnFetch().mockImplementation(() => Promise.resolve(new Response("oops", { status: 500 })));

    render(<VideoBriefForm clients={CLIENTS} defaults={VALID_DEFAULTS} />);
    const user = userEvent.setup();
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    expect(await screen.findByText(/Request failed \(500\)/)).toBeInTheDocument();
  });

  it("falls back to String() coercion for non-Error throws", async () => {
    spyOnFetch().mockImplementation(() => {
      throw "plain string failure";
    });

    render(<VideoBriefForm clients={CLIENTS} defaults={VALID_DEFAULTS} />);
    const user = userEvent.setup();
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Save draft/ }));

    expect(await screen.findByText(/plain string failure/)).toBeInTheDocument();
  });

  it("respects custom defaults when provided", () => {
    render(
      <VideoBriefForm
        clients={CLIENTS}
        defaults={{
          client_id: CLIENT_C2_ID,
          notes: "preset notes",
          target_duration_s: 45,
        }}
      />,
    );

    expect(screen.getByLabelText("Notes (optional)")).toHaveValue("preset notes");
    expect(screen.getByLabelText("Target duration (s)")).toHaveValue(45);
  });
});
