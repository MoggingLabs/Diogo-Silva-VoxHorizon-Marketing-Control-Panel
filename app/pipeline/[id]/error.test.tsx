import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import PipelineDetailError from "./error";

describe("PipelineDetailError", () => {
  it("renders heading + message + digest + retry button", async () => {
    const reset = vi.fn();
    render(
      <PipelineDetailError
        error={Object.assign(new Error("boom"), { digest: "p1" })}
        reset={reset}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /couldn.t load this pipeline/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText(/ref: p1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("omits empty message + digest", () => {
    render(<PipelineDetailError error={new Error("")} reset={vi.fn()} />);
    expect(screen.queryByText(/ref:/i)).not.toBeInTheDocument();
  });
});
