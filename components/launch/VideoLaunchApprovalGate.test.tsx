/**
 * Tests for the video launch approval gate.
 *
 * Same shape as VideoApprovalGate but POSTs to `/api/launches/video/:id/decision`.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VideoLaunchApprovalGate } from "./VideoLaunchApprovalGate";
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

describe("VideoLaunchApprovalGate", () => {
  it("renders three decision buttons", () => {
    render(<VideoLaunchApprovalGate launchId="L1" />);

    expect(screen.getByRole("button", { name: /^Approve$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve with changes/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Reject$/ })).toBeInTheDocument();
  });

  it("requires notes for approved_with_changes", async () => {
    const fetchSpy = spyOnFetch();
    render(<VideoLaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Approve with changes/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires notes for rejected", async () => {
    const fetchSpy = spyOnFetch();
    render(<VideoLaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /^Reject$/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submits a clean approve to the video decision endpoint", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

    render(<VideoLaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/launches/video/L1/decision");
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.decision).toBe("approved");
  });

  it("submits rejection with notes", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

    render(<VideoLaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Notes/), "wrong tone");
    await user.click(screen.getByRole("button", { name: /^Reject$/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.decision).toBe("rejected");
    expect(body.notes).toBe("wrong tone");
  });

  it("surfaces an error body on failure", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: "conflict" }, { status: 409 })),
    );

    render(<VideoLaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));
    expect(await screen.findByText(/conflict/)).toBeInTheDocument();
  });

  it("falls back to 'Request failed' fallback on non-JSON body", async () => {
    spyOnFetch().mockImplementation(() => Promise.resolve(new Response("oops", { status: 500 })));

    render(<VideoLaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));
    expect(await screen.findByText(/Request failed \(500\)/)).toBeInTheDocument();
  });

  it("falls back to String() for non-Error throws", async () => {
    spyOnFetch().mockImplementation(() => {
      throw "plain string fail";
    });

    render(<VideoLaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));
    expect(await screen.findByText(/plain string fail/)).toBeInTheDocument();
  });

  it("shows 'Submitting…' label while in flight", async () => {
    const deferred = createDeferred<Response>();
    spyOnFetch().mockImplementation(() => deferred.promise);

    render(<VideoLaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    expect(screen.getByRole("button", { name: /Submitting…/ })).toBeInTheDocument();

    deferred.resolve(jsonResponse({ ok: true }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
