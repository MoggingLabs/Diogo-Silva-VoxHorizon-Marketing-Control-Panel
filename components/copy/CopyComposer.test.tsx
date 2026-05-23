/**
 * CopyComposer (#359): author/edit/approve ≥3 variants, char counters enforce
 * platform limits, humanizer toggle, suggestions, approved-count gate display,
 * decision + save POSTs.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { CopyComposer, type CopyVariantView } from "./CopyComposer";

const variant = (over: Partial<CopyVariantView> = {}): CopyVariantView => ({
  id: "v1",
  creative_id: "a",
  platform: "meta",
  placement: "feed",
  variant_index: 1,
  headline: "Free roof inspection",
  body: "Get yours today",
  description: "Limited offer",
  cta: "Learn more",
  humanized: false,
  status: "draft",
  ...over,
});

beforeEach(() => {
  routerRefresh.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("CopyComposer", () => {
  it("shows the approved-count gate (amber under 3)", () => {
    render(
      <CopyComposer
        pipelineId="p1"
        creativeId="a"
        creativeLabel="Concept A"
        variants={[variant({ status: "approved" })]}
      />,
    );
    expect(screen.getByTestId("approved-count")).toHaveTextContent("1 / 3 approved");
  });

  it("renders winning-copy suggestions", () => {
    render(
      <CopyComposer
        pipelineId="p1"
        creativeId="a"
        creativeLabel="Concept A"
        variants={[]}
        suggestions={["Pattern X"]}
      />,
    );
    expect(screen.getByTestId("copy-suggestions")).toHaveTextContent("Pattern X");
  });

  it("POSTs an approve decision and refreshes", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ variant: { id: "v1" } }));
    const user = userEvent.setup();
    render(
      <CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[variant()]} />,
    );
    await user.click(screen.getByTestId("approve-v1"));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/pipelines/p1/copy/decision",
        expect.objectContaining({ method: "POST" }),
      );
      expect(routerRefresh).toHaveBeenCalled();
    });
  });

  it("disables Approve when a field is over the platform limit", () => {
    render(
      <CopyComposer
        pipelineId="p1"
        creativeId="a"
        creativeLabel="A"
        variants={[variant({ headline: "h".repeat(300) })]}
      />,
    );
    expect(screen.getByTestId("approve-v1")).toBeDisabled();
    expect(screen.getByTestId("over-limit-v1")).toBeInTheDocument();
  });

  it("saves an edit on blur (re-arm) and refreshes", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ variant: { id: "v1" } }));
    const user = userEvent.setup();
    render(
      <CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[variant()]} />,
    );
    const headline = screen.getByTestId("headline-v1");
    await user.clear(headline);
    await user.type(headline, "New headline");
    await user.tab();
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/pipelines/p1/copy",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("adds a new variant via the upsert route", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ variant: { id: "v2" } }, { status: 201 }));
    const user = userEvent.setup();
    render(<CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[]} />);
    await user.click(screen.getByTestId("add-variant"));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/pipelines/p1/copy",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("surfaces a decision error inline", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ error: "nope" }, { status: 500 }));
    const user = userEvent.setup();
    render(
      <CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[variant()]} />,
    );
    await user.click(screen.getByTestId("approve-v1"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("nope"));
  });

  it("prompts for a reason before rejecting", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("off brand");
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ variant: { id: "v1" } }));
    const user = userEvent.setup();
    render(
      <CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[variant()]} />,
    );
    await user.click(screen.getByTestId("reject-v1"));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    promptSpy.mockRestore();
  });

  it("aborts reject when the prompt is cancelled", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    const fetchSpy = spyOnFetch();
    const user = userEvent.setup();
    render(
      <CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[variant()]} />,
    );
    await user.click(screen.getByTestId("reject-v1"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("toggles the humanizer flag and saves it on blur", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ variant: { id: "v1" } }));
    const user = userEvent.setup();
    render(
      <CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[variant()]} />,
    );
    await user.click(screen.getByTestId("humanize-v1"));
    expect(screen.getByTestId("humanize-v1")).toBeChecked();
    // Blur an input to trigger the save with humanized=true.
    screen.getByTestId("headline-v1").focus();
    await user.tab();
    await waitFor(() => {
      const body = JSON.parse((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body as string);
      expect(body.humanized).toBe(true);
    });
  });

  it("seeds the next variant index from existing variants", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ variant: { id: "v3" } }, { status: 201 }));
    const user = userEvent.setup();
    render(
      <CopyComposer
        pipelineId="p1"
        creativeId="a"
        creativeLabel="A"
        variants={[variant({ id: "v1", variant_index: 5 })]}
      />,
    );
    await user.click(screen.getByTestId("add-variant"));
    await waitFor(() => {
      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.variant_index).toBe(6);
    });
  });

  it("surfaces a save error inline", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ error: "save broke" }, { status: 500 }));
    const user = userEvent.setup();
    render(<CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[]} />);
    await user.click(screen.getByTestId("add-variant"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("save broke"));
  });

  it("surfaces a network error on save", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[]} />);
    await user.click(screen.getByTestId("add-variant"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("offline"));
  });

  it("falls back to a status message on a decision error with no body", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({}, { status: 502 }));
    const user = userEvent.setup();
    render(
      <CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[variant()]} />,
    );
    await user.click(screen.getByTestId("approve-v1"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("502"));
  });

  it("falls back to a status message on a save error with no body", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({}, { status: 503 }));
    const user = userEvent.setup();
    render(<CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[]} />);
    await user.click(screen.getByTestId("add-variant"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("503"));
  });

  it("surfaces a network error on decision", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockRejectedValue(new Error("decline"));
    const user = userEvent.setup();
    render(
      <CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[variant()]} />,
    );
    await user.click(screen.getByTestId("approve-v1"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("decline"));
  });

  it("disables Approve on an already-approved variant and Reject on a rejected one", () => {
    render(
      <CopyComposer
        pipelineId="p1"
        creativeId="a"
        creativeLabel="A"
        variants={[
          variant({ id: "v1", status: "approved" }),
          variant({ id: "v2", status: "rejected" }),
        ]}
      />,
    );
    expect(screen.getByTestId("approve-v1")).toBeDisabled();
    expect(screen.getByTestId("reject-v2")).toBeDisabled();
  });

  it("edits body + description fields (onChange handlers)", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ variant: { id: "v1" } }));
    const user = userEvent.setup();
    render(
      <CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[variant()]} />,
    );
    await user.clear(screen.getByTestId("body-v1"));
    await user.type(screen.getByTestId("body-v1"), "new body");
    await user.clear(screen.getByTestId("description-v1"));
    await user.type(screen.getByTestId("description-v1"), "new desc");
    await user.tab();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  });

  it("handles a google-platform variant (placement falls back)", () => {
    render(
      <CopyComposer
        pipelineId="p1"
        creativeId="a"
        creativeLabel="A"
        variants={[variant({ platform: "google", placement: null })]}
      />,
    );
    expect(screen.getByTestId("variant-v1")).toHaveTextContent("google");
  });

  it("renders an empty composer with no variants", () => {
    render(<CopyComposer pipelineId="p1" creativeId="a" creativeLabel="A" variants={[]} />);
    expect(screen.getByTestId("copy-composer")).toBeInTheDocument();
  });
});
