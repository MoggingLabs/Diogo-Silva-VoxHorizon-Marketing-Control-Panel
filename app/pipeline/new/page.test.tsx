import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const createPipelineRecord = vi.fn();
const redirect = vi.fn((path: string) => {
  // Mimic next's redirect() behaviour: throw a sentinel.
  throw new Error(`__REDIRECT__:${path}`);
});

vi.mock("@/lib/pipeline/queries", () => ({
  createPipelineRecord: (...args: unknown[]) => createPipelineRecord(...args),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirect(path),
}));

import NewPipelinePage from "./page";

describe("NewPipelinePage", () => {
  it("redirects to the new pipeline detail page on success", async () => {
    createPipelineRecord.mockResolvedValueOnce({ id: "p1" });
    await expect(NewPipelinePage()).rejects.toThrow(/__REDIRECT__:\/pipeline\/p1/);
    expect(createPipelineRecord).toHaveBeenCalledWith({ format_choice: "image" });
  });

  it("renders the retry UI when createPipelineRecord fails", async () => {
    createPipelineRecord.mockRejectedValueOnce(new Error("boom"));
    const el = await NewPipelinePage();
    render(el);
    expect(
      screen.getByRole("heading", { name: /couldn.t start a new pipeline/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("renders a generic fallback when createPipelineRecord throws a non-Error", async () => {
    createPipelineRecord.mockRejectedValueOnce("string-thrown");
    const el = await NewPipelinePage();
    render(el);
    expect(screen.getByText(/Failed to start pipeline/i)).toBeInTheDocument();
  });
});
