import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const createPipeline = vi.fn();
const redirect = vi.fn((path: string) => {
  // Mimic next's redirect() behaviour: throw a sentinel.
  throw new Error(`__REDIRECT__:${path}`);
});

vi.mock("@/lib/pipeline/client", () => ({
  createPipeline: (...args: unknown[]) => createPipeline(...args),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirect(path),
}));

import NewPipelinePage from "./page";

describe("NewPipelinePage", () => {
  it("redirects to the new pipeline detail page on success", async () => {
    createPipeline.mockResolvedValueOnce({ id: "p1" });
    await expect(NewPipelinePage()).rejects.toThrow(/__REDIRECT__:\/pipeline\/p1/);
    expect(createPipeline).toHaveBeenCalledWith({ format_choice: "image" });
  });

  it("renders the retry UI when createPipeline fails", async () => {
    createPipeline.mockRejectedValueOnce(new Error("boom"));
    const el = await NewPipelinePage();
    render(el);
    expect(
      screen.getByRole("heading", { name: /couldn.t start a new pipeline/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("renders a generic fallback when createPipeline throws a non-Error", async () => {
    createPipeline.mockRejectedValueOnce("string-thrown");
    const el = await NewPipelinePage();
    render(el);
    expect(screen.getByText(/Failed to start pipeline/i)).toBeInTheDocument();
  });
});
