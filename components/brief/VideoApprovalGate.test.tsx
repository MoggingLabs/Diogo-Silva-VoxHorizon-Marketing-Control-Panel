/**
 * Tests for the video brief approval gate.
 *
 * Same shape as ApprovalGate but POSTs to `/api/briefs/video/:id/approve`
 * and uses the video-side decision schema. Covers:
 *   - All three decision buttons render.
 *   - Notes required for approved_with_changes/rejected; clean approve is fine.
 *   - On submit hits the right endpoint.
 *   - Error response body propagates.
 *   - Non-JSON error response surfaces a "Request failed" fallback.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VideoApprovalGate } from "./VideoApprovalGate";
import { spyOnFetch, jsonResponse } from "@/tests/unit/helpers/worker-mock";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

describe("VideoApprovalGate", () => {
  it("renders three decision buttons", () => {
    render(<VideoApprovalGate videoBriefId="vb1" />);

    expect(screen.getByRole("button", { name: /^Approve$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve with changes/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Reject$/ })).toBeInTheDocument();
  });

  it("requires notes for approved_with_changes", async () => {
    const fetchSpy = spyOnFetch();
    render(<VideoApprovalGate videoBriefId="vb1" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Approve with changes/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires notes for rejected", async () => {
    const fetchSpy = spyOnFetch();
    render(<VideoApprovalGate videoBriefId="vb1" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Reject$/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submits a clean approve to the right endpoint", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

    render(<VideoApprovalGate videoBriefId="vb1" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/briefs/video/vb1/approve");
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.decision).toBe("approved");
    expect(body.notes).toBeUndefined();
  });

  it("submits rejected with provided notes", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

    render(<VideoApprovalGate videoBriefId="vb1" />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Notes/), "wrong tone");
    await user.click(screen.getByRole("button", { name: /^Reject$/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.decision).toBe("rejected");
    expect(body.notes).toBe("wrong tone");
  });

  it("displays the response error body on failure", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: "conflict" }, { status: 409 })),
    );

    render(<VideoApprovalGate videoBriefId="vb1" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));
    expect(await screen.findByText(/conflict/)).toBeInTheDocument();
  });

  it("falls back to 'Request failed' on non-JSON body", async () => {
    spyOnFetch().mockImplementation(() => Promise.resolve(new Response("oops", { status: 500 })));

    render(<VideoApprovalGate videoBriefId="vb1" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));
    expect(await screen.findByText(/Request failed \(500\)/)).toBeInTheDocument();
  });

  it("surfaces a thrown non-Error rejection via String()", async () => {
    spyOnFetch().mockImplementation(() => {
      throw "string failure";
    });

    render(<VideoApprovalGate videoBriefId="vb1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    expect(await screen.findByText(/string failure/)).toBeInTheDocument();
  });

  it("shows the 'Submitting…' label on the in-flight button", async () => {
    const deferred = createDeferred<Response>();
    spyOnFetch().mockImplementation(() => deferred.promise);

    render(<VideoApprovalGate videoBriefId="vb1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    expect(screen.getByRole("button", { name: /Submitting…/ })).toBeInTheDocument();

    deferred.resolve(jsonResponse({ ok: true }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
