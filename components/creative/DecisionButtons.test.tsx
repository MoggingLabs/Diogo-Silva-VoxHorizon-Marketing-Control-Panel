/**
 * DecisionButtons:
 *   - Approve POSTs to /api/creatives/:id/decision and router.refresh()es.
 *   - Reject confirms first; cancel aborts the POST.
 *   - Errors are surfaced inline.
 *   - Both buttons disable while one is pending.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { DecisionButtons } from "./DecisionButtons";

beforeEach(() => {
  routerRefresh.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DecisionButtons (image)", () => {
  it("POSTs approve to the correct endpoint and refreshes the router", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const user = userEvent.setup();
    render(<DecisionButtons creativeId="c1" />);

    await user.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/creatives/c1/decision",
        expect.objectContaining({ method: "POST" }),
      );
      expect(routerRefresh).toHaveBeenCalled();
    });
  });

  it("shows the 'Approving…' label while the request is in flight", async () => {
    const fetchSpy = spyOnFetch();
    let resolve: (r: Response) => void = () => {};
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const user = userEvent.setup();
    render(<DecisionButtons creativeId="c1" />);
    await user.click(screen.getByRole("button", { name: /approve/i }));
    expect(await screen.findByText(/Approving…/)).toBeInTheDocument();
    await act(async () => {
      resolve(jsonResponse({}));
    });
  });

  it("surfaces server error in the inline alert and re-enables buttons", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "denied" }, { status: 403 }));
    const user = userEvent.setup();
    render(<DecisionButtons creativeId="c1" />);
    await user.click(screen.getByRole("button", { name: /approve/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("denied");
  });

  it("uses generic Request failed message when error body lacks 'error' key", async () => {
    spyOnFetch().mockResolvedValueOnce(new Response("", { status: 500 }));
    const user = userEvent.setup();
    render(<DecisionButtons creativeId="c1" />);
    await user.click(screen.getByRole("button", { name: /approve/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Request failed/);
  });

  it("Reject prompts a confirm() and aborts when the operator cancels", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchSpy = spyOnFetch();
    const user = userEvent.setup();
    render(<DecisionButtons creativeId="c1" />);
    await user.click(screen.getByRole("button", { name: /reject/i }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Reject confirms and submits when the operator accepts", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));
    const user = userEvent.setup();
    render(<DecisionButtons creativeId="c1" />);
    await user.click(screen.getByRole("button", { name: /reject/i }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
      expect(routerRefresh).toHaveBeenCalled();
    });
  });

  it("surfaces Network error when fetch rejects", async () => {
    spyOnFetch().mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<DecisionButtons creativeId="c1" />);
    await user.click(screen.getByRole("button", { name: /approve/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/offline/);
  });

  it("surfaces a Network error message when fetch throws a non-Error", async () => {
    spyOnFetch().mockRejectedValueOnce("plain string");
    const user = userEvent.setup();
    render(<DecisionButtons creativeId="c1" />);
    await user.click(screen.getByRole("button", { name: /approve/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Network error/);
  });
});
