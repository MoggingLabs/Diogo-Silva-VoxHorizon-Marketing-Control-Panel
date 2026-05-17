import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import CreativesVideoError from "./error";

describe("CreativesVideoError", () => {
  it("renders heading + message + digest + retry button", async () => {
    const reset = vi.fn();
    render(
      <CreativesVideoError
        error={Object.assign(new Error("boom"), { digest: "v1" })}
        reset={reset}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /couldn.t load video creatives/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText(/ref: v1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("omits empty digest + message", () => {
    render(<CreativesVideoError error={new Error("")} reset={vi.fn()} />);
    expect(screen.queryByText(/ref:/i)).not.toBeInTheDocument();
  });
});
