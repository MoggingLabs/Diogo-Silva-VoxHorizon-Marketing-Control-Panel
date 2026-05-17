import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import AuditError from "./error";

describe("AuditError", () => {
  it("renders the heading + error message + digest + retry", async () => {
    const reset = vi.fn();
    render(
      <AuditError
        error={Object.assign(new Error("supabase down"), { digest: "d1" })}
        reset={reset}
      />,
    );
    expect(screen.getByRole("heading", { name: /audit/i })).toBeInTheDocument();
    expect(screen.getByText(/supabase down/)).toBeInTheDocument();
    expect(screen.getByText(/digest: d1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("falls back to a default message when error.message is empty", () => {
    render(<AuditError error={new Error("")} reset={vi.fn()} />);
    expect(screen.getByText(/an unexpected error occurred/i)).toBeInTheDocument();
  });
});
