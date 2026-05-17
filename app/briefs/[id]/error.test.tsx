import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import BriefDetailError from "./error";

describe("BriefDetailError", () => {
  it("renders heading + message + digest + retry", async () => {
    const reset = vi.fn();
    render(
      <BriefDetailError error={Object.assign(new Error("boom"), { digest: "x1" })} reset={reset} />,
    );
    expect(screen.getByRole("heading", { name: /couldn.t load this brief/i })).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText(/ref: x1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("omits the empty digest/message blocks", () => {
    render(<BriefDetailError error={new Error("")} reset={vi.fn()} />);
    expect(screen.queryByText(/ref:/i)).not.toBeInTheDocument();
  });
});
