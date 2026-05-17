import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/brief/BriefForm", () => ({
  BriefForm: () => <div data-testid="brief-form" />,
}));

import NewBriefPage from "./page";

describe("NewBriefPage", () => {
  it("renders the page header + form", () => {
    render(<NewBriefPage />);
    expect(screen.getByRole("heading", { name: /new image brief/i })).toBeInTheDocument();
    expect(screen.getByTestId("brief-form")).toBeInTheDocument();
  });
});
