import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/clients/ClientForm", () => ({
  ClientForm: () => <div data-testid="form" />,
}));

import NewClientPage from "./page";

describe("NewClientPage", () => {
  it("renders the heading + the client form", () => {
    render(<NewClientPage />);
    expect(screen.getByRole("heading", { name: /new client/i })).toBeInTheDocument();
    expect(screen.getByTestId("form")).toBeInTheDocument();
  });
});
