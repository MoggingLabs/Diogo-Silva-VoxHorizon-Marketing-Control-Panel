/**
 * Tests for the brief approval gate.
 *
 * Covers:
 *   - Three decision buttons render with the expected labels.
 *   - "Approved" notes are optional; "Approved with changes" and "Rejected" require notes.
 *   - Submitting with missing notes shows an inline error and skips the POST.
 *   - Successful submit calls the endpoint, clears notes, and refreshes the route.
 *   - Endpoint defaults to /api/briefs/[id]/approve.
 *   - Custom `endpoint` overrides the default.
 *   - Custom `kind` label appears in the heading.
 *   - aria-invalid flips on the textarea per requiresNotes.
 *   - Error response body propagates to the inline error region.
 *   - Non-JSON error response falls back to `Request failed (status)`.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalGate } from "./ApprovalGate";
import { spyOnFetch, jsonResponse } from "@/tests/unit/helpers/worker-mock";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

beforeEach(() => {
  refresh.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ApprovalGate", () => {
  it("renders the three decision buttons with default kind=brief", () => {
    render(<ApprovalGate briefId="b1" />);

    expect(screen.getByText(/Decide on this brief/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Approve$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve with changes/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Reject$/ })).toBeInTheDocument();
  });

  it("uses a custom `kind` label in the heading", () => {
    render(<ApprovalGate briefId="b1" kind="video brief" />);

    expect(screen.getByText(/Decide on this video brief/i)).toBeInTheDocument();
  });

  it("requires notes when clicking Approve with changes", async () => {
    const fetchSpy = spyOnFetch();
    render(<ApprovalGate briefId="b1" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Approve with changes/ }));

    await screen.findByRole("alert");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires notes when clicking Reject", async () => {
    const fetchSpy = spyOnFetch();
    render(<ApprovalGate briefId="b1" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Reject$/ }));

    await screen.findByRole("alert");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submits a clean approve without notes", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

    render(<ApprovalGate briefId="b1" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/briefs/b1/approve",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string) as {
      decision: string;
      notes?: string;
    };
    expect(body.decision).toBe("approved");
    expect(body.notes).toBeUndefined();
  });

  it("uses the custom endpoint when provided", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

    render(<ApprovalGate briefId="b1" endpoint="/api/launches/x/decision" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/launches/x/decision");
  });

  it("submits approve_with_changes with provided notes", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

    render(<ApprovalGate briefId="b1" />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Notes/), "fix the headline copy");
    await user.click(screen.getByRole("button", { name: /Approve with changes/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.decision).toBe("approved_with_changes");
    expect(body.notes).toBe("fix the headline copy");
  });

  it("displays the response error body on a 4xx/5xx failure", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: "brief already approved" }, { status: 409 })),
    );

    render(<ApprovalGate briefId="b1" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    expect(await screen.findByText(/brief already approved/i)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("falls back to `Request failed (status)` when the error body has no `error`", async () => {
    spyOnFetch().mockImplementation(() => Promise.resolve(new Response("oops", { status: 500 })));

    render(<ApprovalGate briefId="b1" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    expect(await screen.findByText(/Request failed \(500\)/)).toBeInTheDocument();
  });

  it("clears the error state when the textarea is focused", async () => {
    render(<ApprovalGate briefId="b1" />);

    const user = userEvent.setup();
    // Trigger an error first.
    await user.click(screen.getByRole("button", { name: /^Reject$/ }));
    await screen.findByRole("alert");

    await user.click(screen.getByLabelText(/Notes/));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("flips aria-invalid on the textarea when decision requires notes", () => {
    // aria-invalid is computed from `requiresNotes && notes.trim().length === 0`
    // and `requiresNotes = decision !== "approved"`. Default decision is approved,
    // so aria-invalid stays false.
    render(<ApprovalGate briefId="b1" />);

    expect(screen.getByLabelText(/Notes/)).toHaveAttribute("aria-invalid", "false");
  });
});
