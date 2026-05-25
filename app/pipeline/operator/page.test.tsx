import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getOperatorRuns = vi.fn(async () => [] as unknown[]);
vi.mock("@/lib/operator/console", () => ({
  getOperatorRuns: () => getOperatorRuns(),
}));

// The console is a client component with its own spec; stub it here so this
// page test stays a pure structural + seeding check.
vi.mock("@/components/pipeline/OperatorConsole", () => ({
  OperatorConsole: ({ initialRuns }: { initialRuns: unknown[] }) => (
    <div data-testid="operator-console" data-run-count={initialRuns.length} />
  ),
}));

import OperatorConsolePage from "./page";

describe("OperatorConsolePage", () => {
  it("renders the heading, breadcrumb, and seeds the console with operator runs", async () => {
    getOperatorRuns.mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }]);
    const el = await OperatorConsolePage();
    render(el);
    expect(screen.getByRole("heading", { name: /operator console/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /pipeline/i })).toHaveAttribute("href", "/pipeline");
    const console_ = screen.getByTestId("operator-console");
    expect(console_).toHaveAttribute("data-run-count", "2");
  });
});
