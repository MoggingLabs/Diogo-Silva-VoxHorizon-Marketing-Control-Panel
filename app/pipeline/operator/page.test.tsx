import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The kickoff form is a client component with its own spec; stub it here so
// this page test stays a pure structural check.
vi.mock("@/components/pipeline/OperatorKickoffForm", () => ({
  OperatorKickoffForm: () => <div data-testid="operator-kickoff-form" />,
}));

import OperatorKickoffPage from "./page";

describe("OperatorKickoffPage", () => {
  it("renders the heading, breadcrumb, and the kickoff form", () => {
    render(<OperatorKickoffPage />);
    expect(screen.getByRole("heading", { name: /operator pipeline/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /pipeline/i })).toHaveAttribute("href", "/pipeline");
    expect(screen.getByTestId("operator-kickoff-form")).toBeInTheDocument();
  });
});
