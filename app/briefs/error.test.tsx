import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import BriefsError from "./error";

describe("BriefsError", () => {
  it("renders heading + message + digest + retry/back buttons", async () => {
    const reset = vi.fn();
    render(
      <BriefsError error={Object.assign(new Error("boom"), { digest: "abc" })} reset={reset} />,
    );
    expect(screen.getByRole("heading", { name: /couldn.t load briefs/i })).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText(/ref: abc/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to dashboard/i })).toHaveAttribute("href", "/");
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("omits message + digest when empty", () => {
    render(<BriefsError error={new Error("")} reset={vi.fn()} />);
    expect(screen.queryByText(/ref:/i)).not.toBeInTheDocument();
  });
});
