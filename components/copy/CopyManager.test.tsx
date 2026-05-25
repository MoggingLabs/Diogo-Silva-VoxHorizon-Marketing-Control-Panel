/**
 * Tests for the standalone copy CRUD panel (E3.3 / #592).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const archiveCopy = vi.fn();
const restoreCopy = vi.fn();
const createCopy = vi.fn();
const updateCopy = vi.fn();
vi.mock("@/lib/copy/client", () => ({
  archiveCopy: (f: string, id: string) => archiveCopy(f, id),
  restoreCopy: (f: string, id: string) => restoreCopy(f, id),
  createCopy: (b: unknown) => createCopy(b),
  updateCopy: (id: string, b: unknown) => updateCopy(id, b),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CopyManager, type ManagedCopyVariant } from "./CopyManager";

function variant(over: Partial<ManagedCopyVariant> = {}): ManagedCopyVariant {
  return {
    id: "cv1",
    platform: "meta",
    variant_index: 1,
    headline: "Headline one",
    body: "Body copy here",
    description: null,
    cta: null,
    status: "draft",
    deleted_at: null,
    ...over,
  };
}

afterEach(() => vi.clearAllMocks());

describe("CopyManager", () => {
  it("renders variants with status + headline", () => {
    render(<CopyManager format="image" creativeId="cr1" variants={[variant()]} />);
    expect(screen.getByText("Headline one")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("shows the empty state when there are no variants", () => {
    render(<CopyManager format="image" creativeId="cr1" variants={[]} />);
    expect(screen.getByText(/no copy variants yet/i)).toBeInTheDocument();
  });

  it("opens the create drawer from New variant (suggesting next index)", async () => {
    const user = userEvent.setup();
    render(
      <CopyManager format="image" creativeId="cr1" variants={[variant({ variant_index: 2 })]} />,
    );
    await user.click(screen.getByRole("button", { name: /new variant/i }));
    expect(await screen.findByText("New copy variant")).toBeInTheDocument();
    // nextIndex = max(2)+1 = 3.
    expect(screen.getByLabelText(/variant index/i)).toHaveValue("3");
  });

  it("opens the edit drawer with the variant prefilled + a recompliance warning", async () => {
    const user = userEvent.setup();
    render(<CopyManager format="image" creativeId="cr1" variants={[variant()]} />);
    await user.click(screen.getByRole("button", { name: /edit variant 1/i }));
    expect(await screen.findByText("Edit copy variant")).toBeInTheDocument();
    expect(screen.getByText(/re-arms compliance/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/headline/i)).toHaveValue("Headline one");
  });

  it("archives a variant through the confirm dialog (format-aware)", async () => {
    const user = userEvent.setup();
    render(<CopyManager format="video" creativeId="cr1" variants={[variant()]} />);
    await user.click(screen.getByRole("button", { name: /archive variant 1/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^archive$/i }));
    await waitFor(() => expect(archiveCopy).toHaveBeenCalledWith("video", "cv1"));
  });

  it("restores an archived variant on one click", async () => {
    const user = userEvent.setup();
    render(
      <CopyManager
        format="image"
        creativeId="cr1"
        variants={[variant({ deleted_at: "2026-05-25T00:00:00Z" })]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /restore variant 1/i }));
    await waitFor(() => expect(restoreCopy).toHaveBeenCalledWith("image", "cv1"));
  });
});
