import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import VideoLaunchDetailError from "./error";

describe("VideoLaunchDetailError", () => {
  it("renders heading + message + digest + retry", async () => {
    const reset = vi.fn();
    render(
      <VideoLaunchDetailError
        error={Object.assign(new Error("boom"), { digest: "v1" })}
        reset={reset}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /failed to load video launch/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText(/digest: v1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'Unknown error' and skips digest", () => {
    render(<VideoLaunchDetailError error={new Error("")} reset={vi.fn()} />);
    expect(screen.getByText(/unknown error/i)).toBeInTheDocument();
    expect(screen.queryByText(/digest:/i)).not.toBeInTheDocument();
  });
});
