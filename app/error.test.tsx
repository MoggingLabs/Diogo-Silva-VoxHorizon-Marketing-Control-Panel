import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import RootError from "./error";

describe("RootError", () => {
  it("renders the error heading + message + retry button", async () => {
    const reset = vi.fn();
    render(
      <RootError error={Object.assign(new Error("boom"), { digest: "abc123" })} reset={reset} />,
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    expect(screen.getByText(/ref: abc123/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("hides the message + digest when empty", () => {
    render(
      <RootError error={Object.assign(new Error(""), { digest: undefined })} reset={vi.fn()} />,
    );
    expect(screen.queryByText(/ref:/i)).not.toBeInTheDocument();
  });
});
