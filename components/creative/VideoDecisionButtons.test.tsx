/**
 * VideoDecisionButtons has more state branches than the image side:
 *   - `captioned` shows both Approve + Reject
 *   - Earlier statuses (draft → composed) show only Reject + an info note
 *   - Terminal statuses (approved/rejected) show neither
 *   - Reject confirms via window.confirm
 *   - Error / network paths mirror image side
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { VideoDecisionButtons } from "./VideoDecisionButtons";

beforeEach(() => {
  routerRefresh.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VideoDecisionButtons", () => {
  it("shows both approve + reject when status=captioned", () => {
    render(<VideoDecisionButtons creativeId="c1" status="captioned" />);
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
  });

  it("shows only reject + an in-progress note for pre-captioned statuses", () => {
    render(<VideoDecisionButtons creativeId="c1" status="composed" />);
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
    expect(screen.getByText(/Pipeline in progress/i)).toBeInTheDocument();
  });

  it("shows the terminal state notice for approved/rejected", () => {
    const { rerender } = render(<VideoDecisionButtons creativeId="c1" status="approved" />);
    expect(screen.getByText(/No further decision available/)).toBeInTheDocument();
    rerender(<VideoDecisionButtons creativeId="c1" status="rejected" />);
    expect(screen.getByText(/No further decision available/)).toBeInTheDocument();
  });

  it("POSTs approve to the video decision endpoint", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const user = userEvent.setup();
    render(<VideoDecisionButtons creativeId="c1" status="captioned" />);
    await user.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/creatives/video/c1/decision",
        expect.objectContaining({ method: "POST" }),
      );
      expect(routerRefresh).toHaveBeenCalled();
    });
  });

  it("shows the 'Approving…' label while approve is in flight", async () => {
    const fetchSpy = spyOnFetch();
    let resolve: (r: Response) => void = () => {};
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const user = userEvent.setup();
    render(<VideoDecisionButtons creativeId="c1" status="captioned" />);
    await user.click(screen.getByRole("button", { name: /approve/i }));
    expect(await screen.findByText(/Approving…/)).toBeInTheDocument();
    await act(async () => {
      resolve(jsonResponse({}));
    });
  });

  it("Reject confirms then submits", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));
    const user = userEvent.setup();
    render(<VideoDecisionButtons creativeId="c1" status="composed" />);
    await user.click(screen.getByRole("button", { name: /reject/i }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
      expect(routerRefresh).toHaveBeenCalled();
    });
  });

  it("Reject is a no-op when confirm is dismissed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchSpy = spyOnFetch();
    const user = userEvent.setup();
    render(<VideoDecisionButtons creativeId="c1" status="composed" />);
    await user.click(screen.getByRole("button", { name: /reject/i }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces server errors in the inline alert", async () => {
    spyOnFetch().mockResolvedValueOnce(jsonResponse({ error: "boom" }, { status: 422 }));
    const user = userEvent.setup();
    render(<VideoDecisionButtons creativeId="c1" status="captioned" />);
    await user.click(screen.getByRole("button", { name: /approve/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("falls back to 'Request failed (status)' when error body has no error key", async () => {
    spyOnFetch().mockResolvedValueOnce(new Response("", { status: 500 }));
    const user = userEvent.setup();
    render(<VideoDecisionButtons creativeId="c1" status="captioned" />);
    await user.click(screen.getByRole("button", { name: /approve/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Request failed/);
  });

  it("surfaces a Network error on fetch reject", async () => {
    spyOnFetch().mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<VideoDecisionButtons creativeId="c1" status="captioned" />);
    await user.click(screen.getByRole("button", { name: /approve/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/offline/);
  });

  it("surfaces a Network error on non-Error rejection", async () => {
    spyOnFetch().mockRejectedValueOnce("xyz");
    const user = userEvent.setup();
    render(<VideoDecisionButtons creativeId="c1" status="captioned" />);
    await user.click(screen.getByRole("button", { name: /approve/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Network error/);
  });
});
