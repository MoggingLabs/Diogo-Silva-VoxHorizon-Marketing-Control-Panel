/**
 * BrollSelector lets operators pick one clip per segment. Tests cover:
 *  - Empty candidates → placeholder
 *  - Toggle selection on/off
 *  - Confirm POSTs to /api/creatives/video/:id/broll/pick
 *  - Error surfacing
 *  - Confirm button disabled until every segment has a pick
 *  - currentPicks pre-selects existing choices
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";

import { BrollSelector } from "./BrollSelector";

const segments = [
  { idx: 0, topic: "Intro", broll_theme: "morning city" },
  { idx: 1, topic: "Body", broll_theme: undefined },
];

const candidates = [
  {
    segmentIdx: 0,
    clips: [
      {
        segment_idx: 0,
        store_backend: "local" as const,
        clip_id: "c0a",
        in_s: 0,
        out_s: 3,
        source_url: "https://x.example/c0a",
        thumbnail_url: "thumb-a.png",
        theme: "skyline",
      },
      {
        segment_idx: 0,
        store_backend: "local" as const,
        clip_id: "c0b",
        in_s: 0,
        out_s: 4,
        source_url: "https://x.example/c0b",
      },
    ],
  },
  {
    segmentIdx: 1,
    clips: [
      {
        segment_idx: 1,
        store_backend: "local" as const,
        clip_id: "c1a",
        in_s: 0,
        out_s: 2,
        source_url: "https://x.example/c1a",
      },
    ],
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BrollSelector", () => {
  it("renders the placeholder when no candidates exist", () => {
    render(<BrollSelector videoCreativeId="v1" segments={segments} candidates={[]} />);
    expect(screen.getByText(/B-roll search hasn't run yet/)).toBeInTheDocument();
  });

  it("renders one row per segment with its clip strip", () => {
    render(<BrollSelector videoCreativeId="v1" segments={segments} candidates={candidates} />);
    expect(screen.getByText(/Seg 1/)).toBeInTheDocument();
    expect(screen.getByText(/Seg 2/)).toBeInTheDocument();
    expect(screen.getByText("Intro")).toBeInTheDocument();
    expect(screen.getByText("Body")).toBeInTheDocument();
    expect(screen.getByText(/morning city/)).toBeInTheDocument();
  });

  it("disables Confirm until every segment has a pick", async () => {
    const user = userEvent.setup();
    render(<BrollSelector videoCreativeId="v1" segments={segments} candidates={candidates} />);
    const confirm = screen.getByRole("button", { name: /Confirm selection/i });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByLabelText(/Pick c0a for segment 1/));
    expect(confirm).toBeDisabled();
    await user.click(screen.getByLabelText(/Pick c1a for segment 2/));
    expect(confirm).toBeEnabled();
  });

  it("toggling the same clip twice deselects it", async () => {
    const user = userEvent.setup();
    render(<BrollSelector videoCreativeId="v1" segments={segments} candidates={candidates} />);
    const c0a = screen.getByLabelText(/Pick c0a for segment 1/);
    await user.click(c0a);
    expect(c0a).toHaveAttribute("aria-pressed", "true");
    await user.click(c0a);
    expect(c0a).toHaveAttribute("aria-pressed", "false");
  });

  it("pre-selects clips from currentPicks", () => {
    render(
      <BrollSelector
        videoCreativeId="v1"
        segments={segments}
        candidates={candidates}
        currentPicks={[
          {
            segment_idx: 0,
            store_backend: "local",
            clip_id: "c0b",
            in_s: 0,
            out_s: 4,
            source_url: "https://x.example/c0b",
          },
        ]}
      />,
    );
    expect(screen.getByLabelText(/Pick c0b for segment 1/)).toHaveAttribute("aria-pressed", "true");
  });

  it("Confirm POSTs the picks and surfaces the saved banner", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <BrollSelector
        videoCreativeId="v1"
        segments={segments}
        candidates={candidates}
        onSaved={onSaved}
      />,
    );
    await user.click(screen.getByLabelText(/Pick c0a for segment 1/));
    await user.click(screen.getByLabelText(/Pick c1a for segment 2/));
    await user.click(screen.getByRole("button", { name: /Confirm selection/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/creatives/video/v1/broll/pick",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText(/Picks saved/)).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
  });

  it("surfaces error from server when pick fails", async () => {
    spyOnFetch().mockResolvedValueOnce(jsonResponse({ error: "rejected" }, { status: 422 }));
    const user = userEvent.setup();
    render(<BrollSelector videoCreativeId="v1" segments={segments} candidates={candidates} />);
    await user.click(screen.getByLabelText(/Pick c0a for segment 1/));
    await user.click(screen.getByLabelText(/Pick c1a for segment 2/));
    await user.click(screen.getByRole("button", { name: /Confirm selection/i }));
    expect(await screen.findByText(/rejected/)).toBeInTheDocument();
  });

  it("falls back to a generic message when error body is unparsable", async () => {
    spyOnFetch().mockResolvedValueOnce(new Response("not json", { status: 500 }));
    const user = userEvent.setup();
    render(<BrollSelector videoCreativeId="v1" segments={segments} candidates={candidates} />);
    await user.click(screen.getByLabelText(/Pick c0a for segment 1/));
    await user.click(screen.getByLabelText(/Pick c1a for segment 2/));
    await user.click(screen.getByRole("button", { name: /Confirm selection/i }));
    expect(await screen.findByText(/HTTP 500/)).toBeInTheDocument();
  });

  it("surfaces network error when fetch rejects", async () => {
    spyOnFetch().mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<BrollSelector videoCreativeId="v1" segments={segments} candidates={candidates} />);
    await user.click(screen.getByLabelText(/Pick c0a for segment 1/));
    await user.click(screen.getByLabelText(/Pick c1a for segment 2/));
    await user.click(screen.getByRole("button", { name: /Confirm selection/i }));
    expect(await screen.findByText(/offline/)).toBeInTheDocument();
  });

  it("renders the source link and stops event propagation on click", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <BrollSelector
        videoCreativeId="v1"
        segments={segments}
        candidates={candidates}
        onSaved={onSaved}
      />,
    );
    const sourceLink = screen.getAllByLabelText("Open source")[0]!;
    expect(sourceLink).toBeInTheDocument();
    // Click the link; the parent button should NOT toggle the picked state.
    const c0a = screen.getByLabelText(/Pick c0a for segment 1/);
    await user.click(sourceLink);
    expect(c0a).toHaveAttribute("aria-pressed", "false");
  });

  it("skips segments with no candidate clips when rendering rows", () => {
    render(
      <BrollSelector
        videoCreativeId="v1"
        segments={[
          { idx: 0, topic: "First" },
          { idx: 1, topic: "Second (no clips)" },
        ]}
        candidates={[
          {
            segmentIdx: 0,
            clips: [candidates[0]!.clips[0]!],
          },
          { segmentIdx: 1, clips: [] },
        ]}
      />,
    );
    // First segment renders; second segment skipped.
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.queryByText("Second (no clips)")).not.toBeInTheDocument();
  });
});
