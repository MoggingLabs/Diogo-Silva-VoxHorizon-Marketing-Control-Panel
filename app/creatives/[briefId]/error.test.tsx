import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import CreativesError from "./error";

describe("CreativesError", () => {
  it("renders heading + message + digest + retry", async () => {
    const reset = vi.fn();
    render(
      <CreativesError error={Object.assign(new Error("boom"), { digest: "c1" })} reset={reset} />,
    );
    expect(screen.getByRole("heading", { name: /couldn.t load creatives/i })).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText(/ref: c1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("omits empty message + digest", () => {
    render(<CreativesError error={new Error("")} reset={vi.fn()} />);
    expect(screen.queryByText(/ref:/i)).not.toBeInTheDocument();
  });
});
