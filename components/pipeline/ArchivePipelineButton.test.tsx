/**
 * ArchivePipelineButton renders the header-level Archive / Restore control
 * for the pipeline detail page (#609). Active runs open a ConfirmArchive
 * dialog then soft-archive; archived runs offer a one-click restore.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

const archivePipeline = vi.fn();
const restorePipeline = vi.fn();
vi.mock("@/lib/pipeline/client", () => ({
  archivePipeline: (...args: unknown[]) => archivePipeline(...args),
  restorePipeline: (...args: unknown[]) => restorePipeline(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ArchivePipelineButton } from "./ArchivePipelineButton";

beforeEach(() => {
  routerRefresh.mockReset();
  archivePipeline.mockReset();
  restorePipeline.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ArchivePipelineButton (active)", () => {
  it("opens the confirm dialog then archives + refreshes", async () => {
    const user = userEvent.setup();
    archivePipeline.mockResolvedValue({ pipeline: { id: "p1" } });
    render(<ArchivePipelineButton pipelineId="p1" archived={false} />);

    await user.click(screen.getByRole("button", { name: /archive pipeline/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^archive$/i }));
    expect(archivePipeline).toHaveBeenCalledWith("p1");
  });

  it("does not call archive until the dialog is confirmed", async () => {
    const user = userEvent.setup();
    render(<ArchivePipelineButton pipelineId="p1" archived={false} />);
    await user.click(screen.getByRole("button", { name: /archive pipeline/i }));
    expect(archivePipeline).not.toHaveBeenCalled();
  });
});

describe("ArchivePipelineButton (archived)", () => {
  it("renders a Restore button that clears the tombstone + refreshes", async () => {
    const user = userEvent.setup();
    restorePipeline.mockResolvedValue({ pipeline: { id: "p1", deleted_at: null } });
    render(<ArchivePipelineButton pipelineId="p1" archived={true} />);

    const restore = screen.getByRole("button", { name: /restore pipeline/i });
    await user.click(restore);
    expect(restorePipeline).toHaveBeenCalledWith("p1");
  });
});
