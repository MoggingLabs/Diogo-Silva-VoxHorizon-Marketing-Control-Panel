/**
 * Tests for the image launch approval gate.
 *
 * Mirrors VideoLaunchApprovalGate but POSTs to `/api/launches/:id/decision`.
 * Covers the optimistic status flip (pill flips from the decision response
 * without the slow server re-render) and the revert on a failed POST.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LaunchApprovalGate } from "./LaunchApprovalGate";
import { LaunchStatusBadge, LaunchStatusProvider } from "./LaunchStatusBadge";
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

function renderWithStatus(launchId: string, serverStatus = "posted") {
  return render(
    <LaunchStatusProvider serverStatus={serverStatus}>
      <LaunchStatusBadge status={serverStatus} />
      <LaunchApprovalGate launchId={launchId} />
    </LaunchStatusProvider>,
  );
}

describe("LaunchApprovalGate", () => {
  it("renders three decision buttons", () => {
    render(<LaunchApprovalGate launchId="L1" />);

    expect(screen.getByRole("button", { name: /^Approve$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve with changes/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Reject$/ })).toBeInTheDocument();
  });

  it("requires notes for approved_with_changes", async () => {
    const fetchSpy = spyOnFetch();
    render(<LaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Approve with changes/ }));
    expect(await screen.findByTestId("launch-decision-error")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires notes for rejected", async () => {
    const fetchSpy = spyOnFetch();
    render(<LaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /^Reject$/ }));
    expect(await screen.findByTestId("launch-decision-error")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submits a clean approve to the launch decision endpoint", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse({ launch: { status: "approved" } })),
    );

    render(<LaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/launches/L1/decision");
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.decision).toBe("approved");
  });

  it("submits rejection with notes", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse({ launch: { status: "rejected" } })),
    );

    render(<LaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Notes/), "wrong tone");
    await user.click(screen.getByRole("button", { name: /^Reject$/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.decision).toBe("rejected");
    expect(body.notes).toBe("wrong tone");
  });

  it("flips the status pill optimistically from the decision response and hides the gate", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ launch: { status: "approved" } })),
    );

    renderWithStatus("L1");
    expect(screen.getByText("Posted", { exact: true })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    await waitFor(() => expect(screen.getByText("Approved", { exact: true })).toBeInTheDocument());
    expect(screen.queryByText("Posted", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Approve$/ })).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("falls back to the chosen decision when the response omits launch.status", async () => {
    spyOnFetch().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

    renderWithStatus("L1");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Notes/), "adjust the body copy");
    await user.click(screen.getByRole("button", { name: /Approve with changes/ }));

    await waitFor(() =>
      expect(screen.getByText("Approved with changes", { exact: true })).toBeInTheDocument(),
    );
  });

  it("falls back to the chosen decision when an ok response has a non-JSON body", async () => {
    // status 200 (res.ok) but an unparseable body: the success-path
    // res.json().catch(() => ({})) fires and we flip to the chosen decision.
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(new Response("not json", { status: 200 })),
    );

    renderWithStatus("L1");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    await waitFor(() => expect(screen.getByText("Approved", { exact: true })).toBeInTheDocument());
    expect(refresh).toHaveBeenCalled();
  });

  it("reverts the optimistic pill when the decision POST fails", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: "conflict" }, { status: 409 })),
    );

    renderWithStatus("L1");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    expect(await screen.findByText(/conflict/)).toBeInTheDocument();
    expect(screen.getByText("Posted", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Approved", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Approve$/ })).toBeInTheDocument();
  });

  it("surfaces an error body on failure", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: "conflict" }, { status: 409 })),
    );

    render(<LaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));
    expect(await screen.findByText(/conflict/)).toBeInTheDocument();
  });

  it("falls back to 'Request failed' fallback on non-JSON body", async () => {
    spyOnFetch().mockImplementation(() => Promise.resolve(new Response("oops", { status: 500 })));

    render(<LaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));
    expect(await screen.findByText(/Request failed \(500\)/)).toBeInTheDocument();
  });

  it("falls back to String() for non-Error throws", async () => {
    spyOnFetch().mockImplementation(() => {
      throw "plain string fail";
    });

    render(<LaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));
    expect(await screen.findByText(/plain string fail/)).toBeInTheDocument();
  });

  it("shows 'Submitting…' label while in flight", async () => {
    const deferred = createDeferred<Response>();
    spyOnFetch().mockImplementation(() => deferred.promise);

    render(<LaunchApprovalGate launchId="L1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    expect(screen.getByRole("button", { name: /Submitting…/ })).toBeInTheDocument();

    deferred.resolve(jsonResponse({ launch: { status: "approved" } }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
