/**
 * Tests for the copy editor drawer (E3.3 / #592).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const createCopy = vi.fn();
const updateCopy = vi.fn();
vi.mock("@/lib/copy/client", () => ({
  createCopy: (b: unknown) => createCopy(b),
  updateCopy: (id: string, b: unknown) => updateCopy(id, b),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CopyEditorDrawer, type CopyVariantLike } from "./CopyEditorDrawer";

const existing: CopyVariantLike = {
  id: "cv1",
  platform: "meta",
  variant_index: 2,
  headline: "Old headline",
  body: "Old body",
  description: null,
  cta: "Learn more",
};

afterEach(() => vi.clearAllMocks());

describe("CopyEditorDrawer", () => {
  it("creates a new variant with the format + creative id", async () => {
    const user = userEvent.setup();
    render(
      <CopyEditorDrawer
        open
        onOpenChange={vi.fn()}
        format="image"
        creativeId="cr1"
        nextIndex={3}
      />,
    );
    await user.type(screen.getByLabelText(/headline/i), "Fresh headline");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(createCopy).toHaveBeenCalled());
    const body = createCopy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({
      format: "image",
      creative_id: "cr1",
      variant_index: 3,
      headline: "Fresh headline",
    });
    expect(updateCopy).not.toHaveBeenCalled();
  });

  it("edits an existing variant (PATCH) and surfaces the recompliance warning", async () => {
    const user = userEvent.setup();
    render(
      <CopyEditorDrawer
        open
        onOpenChange={vi.fn()}
        format="video"
        creativeId="cr1"
        variant={existing}
      />,
    );
    expect(screen.getByText(/re-arms compliance/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/headline/i)).toHaveValue("Old headline");

    const headline = screen.getByLabelText(/headline/i);
    await user.clear(headline);
    await user.type(headline, "Edited headline");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateCopy).toHaveBeenCalled());
    const [id, body] = updateCopy.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe("cv1");
    expect(body).toMatchObject({ format: "video", headline: "Edited headline", variant_index: 2 });
    expect(createCopy).not.toHaveBeenCalled();
  });

  it("blocks submit on an out-of-range variant index", async () => {
    const user = userEvent.setup();
    render(
      <CopyEditorDrawer
        open
        onOpenChange={vi.fn()}
        format="image"
        creativeId="cr1"
        nextIndex={1}
      />,
    );
    const index = screen.getByLabelText(/variant index/i);
    await user.clear(index);
    await user.type(index, "0");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText(/min 1/i)).toBeInTheDocument());
    expect(createCopy).not.toHaveBeenCalled();
  });
});
