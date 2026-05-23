/**
 * StageCopy: lists a CopyComposer per in-scope creative; Continue unlocks once
 * every creative has ≥3 approved variants; advances via the advance route.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { StageCopy } from "./StageCopy";
import type { CopyVariantView } from "@/components/copy/CopyComposer";
import type { GridCreative } from "@/lib/review/grid";

const creatives: GridCreative[] = [{ id: "a", concept: "Concept A", status: "draft" }];

const approvedThree: CopyVariantView[] = [1, 2, 3].map((i) => ({
  id: `v${i}`,
  creative_id: "a",
  platform: "meta",
  placement: "feed",
  variant_index: i,
  headline: "h",
  body: "b",
  description: "d",
  cta: "c",
  humanized: false,
  status: "approved",
}));

beforeEach(() => routerRefresh.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("StageCopy", () => {
  it("renders a composer per in-scope creative", () => {
    render(<StageCopy pipelineId="p1" creatives={creatives} variants={[]} />);
    expect(screen.getByTestId("copy-composer")).toBeInTheDocument();
  });

  it("disables Continue until each creative has ≥3 approved", () => {
    render(
      <StageCopy pipelineId="p1" creatives={creatives} variants={approvedThree.slice(0, 2)} />,
    );
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });

  it("enables Continue when all creatives have ≥3 approved", () => {
    render(<StageCopy pipelineId="p1" creatives={creatives} variants={approvedThree} />);
    expect(screen.getByRole("button", { name: /continue/i })).not.toBeDisabled();
  });

  it("advances via the advance route", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ pipeline: { status: "spec_validation" } }));
    const user = userEvent.setup();
    render(<StageCopy pipelineId="p1" creatives={creatives} variants={approvedThree} />);
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/pipelines/p1/advance",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("surfaces an advance error inline", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ error: "still short" }, { status: 422 }));
    const user = userEvent.setup();
    render(<StageCopy pipelineId="p1" creatives={creatives} variants={approvedThree} />);
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(screen.getByText("still short")).toBeInTheDocument());
  });

  it("surfaces a network error inline", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<StageCopy pipelineId="p1" creatives={creatives} variants={approvedThree} />);
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(screen.getByText("offline")).toBeInTheDocument());
  });

  it("falls back to a status message when the error body is empty", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({}, { status: 502 }));
    const user = userEvent.setup();
    render(<StageCopy pipelineId="p1" creatives={creatives} variants={approvedThree} />);
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(screen.getByText(/502/)).toBeInTheDocument());
  });

  it("renders an empty state with no in-scope creatives", () => {
    render(
      <StageCopy
        pipelineId="p1"
        creatives={[{ id: "a", concept: "A", status: "killed" }]}
        variants={[]}
      />,
    );
    expect(screen.getByText(/No creatives in scope/)).toBeInTheDocument();
  });
});
