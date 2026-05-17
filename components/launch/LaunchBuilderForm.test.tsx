/**
 * Tests for the launch builder.
 *
 * Two modes:
 *   - scratch: dropdown of approved briefs, submit calls createLaunchPackage with just brief_id.
 *   - pipeline: prefilled brief + creatives, submit also passes pipeline_id.
 *
 * We mock `createLaunchPackage` from `@/lib/pipeline/client` and the router.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const back = vi.fn();
const createLaunchPackage = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, back, refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/pipeline/client", () => ({
  createLaunchPackage: (...args: unknown[]) => createLaunchPackage(...args),
}));

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

import { LaunchBuilderForm } from "./LaunchBuilderForm";
import type { Creative } from "@/lib/creatives";

beforeEach(() => {
  push.mockReset();
  back.mockReset();
  createLaunchPackage.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("LaunchBuilderForm (scratch mode)", () => {
  it("renders the brief dropdown with each eligible brief", () => {
    render(
      <LaunchBuilderForm
        mode="scratch"
        eligibleBriefs={[
          { id: "b1", brief_id_human: "BRF-001", client_name: "Acme" },
          { id: "b2", brief_id_human: "BRF-002", client_name: null },
        ]}
      />,
    );

    expect(screen.getByText("BRF-001 — Acme")).toBeInTheDocument();
    expect(screen.getByText("BRF-002")).toBeInTheDocument();
  });

  it('shows the "no approved briefs" copy when the list is empty', () => {
    render(<LaunchBuilderForm mode="scratch" eligibleBriefs={[]} />);

    expect(
      screen.getByText(/No approved briefs found\. Approve a brief first/i),
    ).toBeInTheDocument();
  });

  it("disables the submit button when no brief is selected", () => {
    render(
      <LaunchBuilderForm
        mode="scratch"
        eligibleBriefs={[{ id: "b1", brief_id_human: "BRF-001", client_name: null }]}
      />,
    );

    expect(screen.getByRole("button", { name: /Build launch package/ })).toBeDisabled();
  });

  it("submits with the selected brief and routes to the new launch", async () => {
    createLaunchPackage.mockResolvedValue({ id: "L-1" });

    render(
      <LaunchBuilderForm
        mode="scratch"
        eligibleBriefs={[{ id: "b1", brief_id_human: "BRF-001", client_name: "Acme" }]}
      />,
    );

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/Approved brief/), "b1");
    await user.click(screen.getByRole("button", { name: /Build launch package/ }));

    await waitFor(() => expect(createLaunchPackage).toHaveBeenCalled());
    expect(createLaunchPackage).toHaveBeenCalledWith({ brief_id: "b1" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/launches/L-1"));
  });

  it("surfaces an error from createLaunchPackage", async () => {
    createLaunchPackage.mockRejectedValue(new Error("pre-flight failed"));

    render(
      <LaunchBuilderForm
        mode="scratch"
        eligibleBriefs={[{ id: "b1", brief_id_human: "BRF-001", client_name: null }]}
      />,
    );

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/Approved brief/), "b1");
    await user.click(screen.getByRole("button", { name: /Build launch package/ }));

    expect(await screen.findByText(/pre-flight failed/)).toBeInTheDocument();
  });

  it("falls back to String() coercion for non-Error throws", async () => {
    createLaunchPackage.mockRejectedValue("plain string");

    render(
      <LaunchBuilderForm
        mode="scratch"
        eligibleBriefs={[{ id: "b1", brief_id_human: "BRF-001", client_name: null }]}
      />,
    );

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/Approved brief/), "b1");
    await user.click(screen.getByRole("button", { name: /Build launch package/ }));

    expect(await screen.findByText(/plain string/)).toBeInTheDocument();
  });

  it("navigates back when Cancel is clicked", async () => {
    render(<LaunchBuilderForm mode="scratch" eligibleBriefs={[]} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Cancel/ }));

    expect(back).toHaveBeenCalled();
  });
});

describe("LaunchBuilderForm (pipeline mode)", () => {
  function fakeCreative(over: Partial<Creative>): Creative {
    return {
      id: "cr-1",
      brief_id: "b1",
      concept: "Hook A",
      ratio: "1x1",
      version: "1.0",
      status: "approved",
      file_path_drive: null,
      file_path_supabase: null,
      drive_url: null,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
      ...over,
    } as Creative;
  }

  it("renders the brief reference and budget hint", () => {
    render(
      <LaunchBuilderForm
        mode="pipeline"
        prefill={{
          pipeline_id: "p1",
          brief: { id: "b1", brief_id_human: "BRF-001" },
          creatives: [],
          budget_hint: 5000,
        }}
      />,
    );

    expect(screen.getByText("BRF-001")).toBeInTheDocument();
    expect(screen.getByText(/Budget hint:/)).toBeInTheDocument();
    expect(screen.getByText(/\$5,000/)).toBeInTheDocument();
  });

  it("renders the no-image-brief warning when prefill.brief is null", () => {
    render(
      <LaunchBuilderForm
        mode="pipeline"
        prefill={{
          pipeline_id: "p1",
          brief: null,
          creatives: [],
          budget_hint: null,
        }}
      />,
    );

    expect(screen.getByText(/This pipeline has no image brief/)).toBeInTheDocument();
  });

  it("renders each prefilled creative in the attached list", () => {
    const creatives = [
      fakeCreative({ id: "c1", concept: "Concept A" }),
      fakeCreative({ id: "c2", concept: "Concept B" }),
    ];

    render(
      <LaunchBuilderForm
        mode="pipeline"
        prefill={{
          pipeline_id: "p1",
          brief: { id: "b1", brief_id_human: "BRF-001" },
          creatives,
          budget_hint: null,
        }}
      />,
    );

    expect(screen.getByText("Concept A")).toBeInTheDocument();
    expect(screen.getByText("Concept B")).toBeInTheDocument();
    // Header reflects 2 of 2 attached
    expect(screen.getByText(/Attached creatives \(2 of 2\)/)).toBeInTheDocument();
  });

  it("falls back to 'Untitled' when concept is null", () => {
    render(
      <LaunchBuilderForm
        mode="pipeline"
        prefill={{
          pipeline_id: "p1",
          brief: { id: "b1", brief_id_human: "BRF-001" },
          creatives: [fakeCreative({ concept: null })],
          budget_hint: null,
        }}
      />,
    );

    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });

  it("toggles a creative between Remove and Re-include", async () => {
    render(
      <LaunchBuilderForm
        mode="pipeline"
        prefill={{
          pipeline_id: "p1",
          brief: { id: "b1", brief_id_human: "BRF-001" },
          creatives: [fakeCreative({ id: "c1", concept: "A" })],
          budget_hint: null,
        }}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Remove from preview/ }));
    // After exclusion: header should show (0 of 1) and the button flips.
    expect(screen.getByText(/Attached creatives \(0 of 1\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Re-include/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Re-include/ }));
    expect(screen.getByText(/Attached creatives \(1 of 1\)/)).toBeInTheDocument();
  });

  it("submits with both brief_id and pipeline_id", async () => {
    createLaunchPackage.mockResolvedValue({ id: "L-7" });

    render(
      <LaunchBuilderForm
        mode="pipeline"
        prefill={{
          pipeline_id: "p1",
          brief: { id: "b1", brief_id_human: "BRF-001" },
          creatives: [],
          budget_hint: null,
        }}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Build launch package/ }));

    await waitFor(() => expect(createLaunchPackage).toHaveBeenCalled());
    expect(createLaunchPackage).toHaveBeenCalledWith({
      brief_id: "b1",
      pipeline_id: "p1",
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/launches/L-7"));
  });

  it("renders the 'Building…' button label while submission is pending", async () => {
    const deferred = createDeferred<{ id: string }>();
    createLaunchPackage.mockImplementation(() => deferred.promise);

    render(
      <LaunchBuilderForm
        mode="pipeline"
        prefill={{
          pipeline_id: "p1",
          brief: { id: "b1", brief_id_human: "BRF-001" },
          creatives: [],
          budget_hint: null,
        }}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Build launch package/ }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Building/ })).toBeInTheDocument(),
    );

    deferred.resolve({ id: "L-2" });
    await waitFor(() => expect(push).toHaveBeenCalled());
  });

  it("disables the submit button when no brief is selected (scratch mode)", () => {
    render(<LaunchBuilderForm mode="scratch" eligibleBriefs={[]} />);

    expect(screen.getByRole("button", { name: /Build launch package/ })).toBeDisabled();
  });
});
