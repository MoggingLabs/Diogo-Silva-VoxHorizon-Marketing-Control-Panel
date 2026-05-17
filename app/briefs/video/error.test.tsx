import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import VideoBriefsError from "./error";

describe("VideoBriefsError", () => {
  it("renders message + digest + retry button", async () => {
    const reset = vi.fn();
    render(
      <VideoBriefsError
        error={Object.assign(new Error("boom"), { digest: "abc" })}
        reset={reset}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /couldn.t load video briefs/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText(/ref: abc/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("omits message + digest when empty", () => {
    render(<VideoBriefsError error={new Error("")} reset={vi.fn()} />);
    expect(screen.queryByText(/ref:/i)).not.toBeInTheDocument();
  });
});
