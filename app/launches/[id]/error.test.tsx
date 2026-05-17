import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import LaunchDetailError from "./error";

describe("LaunchDetailError", () => {
  it("renders heading + message + digest + retry button", async () => {
    const reset = vi.fn();
    render(
      <LaunchDetailError
        error={Object.assign(new Error("boom"), { digest: "l1" })}
        reset={reset}
      />,
    );
    expect(screen.getByRole("heading", { name: /failed to load launch/i })).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText(/digest: l1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'Unknown error' for empty messages and skips digest", () => {
    render(<LaunchDetailError error={new Error("")} reset={vi.fn()} />);
    expect(screen.getByText(/unknown error/i)).toBeInTheDocument();
    expect(screen.queryByText(/digest:/i)).not.toBeInTheDocument();
  });
});
