/**
 * Tests for the brief Archive / Restore control (E3.2 / #591).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const archiveBrief = vi.fn();
const restoreBrief = vi.fn();
vi.mock("@/lib/briefs-client", () => ({
  archiveBrief: (f: string, id: string) => archiveBrief(f, id),
  restoreBrief: (f: string, id: string) => restoreBrief(f, id),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

import { BriefArchiveButton } from "./BriefArchiveButton";

afterEach(() => vi.clearAllMocks());

describe("BriefArchiveButton", () => {
  it("archives an active brief through the confirm dialog (format-aware)", async () => {
    const user = userEvent.setup();
    render(<BriefArchiveButton format="image" briefId="b1" archived={false} />);
    await user.click(screen.getByRole("button", { name: /archive brief/i }));
    // ConfirmArchive dialog → confirm.
    await user.click(screen.getByRole("button", { name: /^archive$/i }));
    await waitFor(() => expect(archiveBrief).toHaveBeenCalledWith("image", "b1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("restores an archived video brief on one click", async () => {
    const user = userEvent.setup();
    render(<BriefArchiveButton format="video" briefId="v1" archived />);
    await user.click(screen.getByRole("button", { name: /restore brief/i }));
    await waitFor(() => expect(restoreBrief).toHaveBeenCalledWith("video", "v1"));
    expect(toastSuccess).toHaveBeenCalledWith("Brief restored");
    expect(refresh).toHaveBeenCalled();
  });

  it("surfaces a restore failure as an error toast", async () => {
    restoreBrief.mockRejectedValueOnce(new Error("nope"));
    const user = userEvent.setup();
    render(<BriefArchiveButton format="image" briefId="b9" archived />);
    await user.click(screen.getByRole("button", { name: /restore brief/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("nope"));
    expect(refresh).not.toHaveBeenCalled();
  });
});
