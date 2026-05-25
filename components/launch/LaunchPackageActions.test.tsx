/**
 * LaunchPackageActions (E5.1 / #595): edit notes / archive / restore in the
 * launch detail header. Works for both formats via the `format` prop.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const archiveLaunch = vi.fn(async () => undefined);
const restoreLaunch = vi.fn(async () => undefined);
const updateLaunch = vi.fn(async () => undefined);
vi.mock("@/lib/launches/client", () => ({
  archiveLaunch: (...a: unknown[]) => archiveLaunch(...(a as [])),
  restoreLaunch: (...a: unknown[]) => restoreLaunch(...(a as [])),
  updateLaunch: (...a: unknown[]) => updateLaunch(...(a as [])),
}));

import { LaunchPackageActions } from "./LaunchPackageActions";

beforeEach(() => {
  routerRefresh.mockReset();
  archiveLaunch.mockClear();
  restoreLaunch.mockClear();
  updateLaunch.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("LaunchPackageActions", () => {
  it("edits the operator notes via PATCH", async () => {
    const user = userEvent.setup();
    render(
      <LaunchPackageActions format="image" launchId="l1" decidedNotes="old" archived={false} />,
    );
    await user.click(screen.getByRole("button", { name: /edit notes/i }));
    const dialog = await screen.findByRole("dialog");
    const textarea = within(dialog).getByLabelText(/notes/i);
    await user.clear(textarea);
    await user.type(textarea, "new note");
    await user.click(within(dialog).getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(updateLaunch).toHaveBeenCalledWith("image", "l1", { decided_notes: "new note" }),
    );
  });

  it("archives via the confirm dialog", async () => {
    const user = userEvent.setup();
    render(
      <LaunchPackageActions format="video" launchId="v1" decidedNotes={null} archived={false} />,
    );
    await user.click(screen.getByRole("button", { name: /archive launch/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^archive$/i }));
    await waitFor(() => expect(archiveLaunch).toHaveBeenCalledWith("video", "v1"));
  });

  it("shows a Restore button when archived and restores", async () => {
    const user = userEvent.setup();
    render(<LaunchPackageActions format="image" launchId="l1" decidedNotes={null} archived />);
    // No edit / archive controls while archived.
    expect(screen.queryByRole("button", { name: /edit notes/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /restore launch/i }));
    await waitFor(() => expect(restoreLaunch).toHaveBeenCalledWith("image", "l1"));
  });
});
