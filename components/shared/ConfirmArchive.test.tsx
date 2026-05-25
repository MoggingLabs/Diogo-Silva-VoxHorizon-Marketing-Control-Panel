/**
 * Tests for ConfirmArchive (single + bulk soft-delete confirmation).
 *
 * Covers: default singular copy, bulk copy with count, destructive variant
 * copy + verb, the confirm -> toast.success -> onSuccess -> close lifecycle,
 * the error path (onConfirm throws -> toast.error, stays open), and Cancel.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

import { ConfirmArchive } from "./ConfirmArchive";

afterEach(() => {
  vi.clearAllMocks();
});

describe("ConfirmArchive", () => {
  it("renders singular archive copy by default", () => {
    render(<ConfirmArchive open onOpenChange={vi.fn()} resourceName="brief" onConfirm={vi.fn()} />);
    expect(screen.getByText(/archive this brief\?/i)).toBeInTheDocument();
    expect(screen.getByText(/restore it later/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
  });

  it("renders bulk copy with the count", () => {
    render(
      <ConfirmArchive
        open
        onOpenChange={vi.fn()}
        count={3}
        resourceName="creative"
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/archive 3 creatives\?/i)).toBeInTheDocument();
  });

  it("uses destructive verb + copy when destructive", () => {
    render(
      <ConfirmArchive
        open
        onOpenChange={vi.fn()}
        resourceName="offer"
        destructive
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/delete this offer\?/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("confirms: calls onConfirm, toasts success, onSuccess, and closes", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmArchive
        open
        onOpenChange={onOpenChange}
        resourceName="brief"
        onConfirm={onConfirm}
        onSuccess={onSuccess}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith("Brief archived");
    expect(onSuccess).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("toasts an error and stays open when onConfirm throws", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockRejectedValue(new Error("nope"));
    const onOpenChange = vi.fn();
    render(
      <ConfirmArchive
        open
        onOpenChange={onOpenChange}
        resourceName="brief"
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("nope"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("cancels without confirming", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmArchive
        open
        onOpenChange={onOpenChange}
        resourceName="brief"
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
