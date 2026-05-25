/**
 * Tests for the Kanban column primitive.
 *
 * Pure presentation. Covers:
 *   - Header rendering (title + count + accent dot).
 *   - Empty-state copy when no cards.
 *   - Custom emptyMessage override.
 *   - Custom accent class.
 *   - Render children when content exists.
 *   - Handles single child (not array) correctly.
 *   - Skips empty state when children include falsy entries but at least one truthy.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { KanbanColumn } from "./KanbanColumn";

describe("KanbanColumn", () => {
  it("renders the title and locale-formatted count", () => {
    render(<KanbanColumn title="In Brief" count={1234} />);

    expect(screen.getByText("In Brief")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
  });

  it("renders the default empty-state copy when there are no children", () => {
    render(<KanbanColumn title="In Brief" count={0} />);

    expect(screen.getByText("No data yet.")).toBeInTheDocument();
  });

  it("renders a custom empty message when provided", () => {
    render(<KanbanColumn title="Live" count={0} emptyMessage="Nothing live right now." />);

    expect(screen.getByText("Nothing live right now.")).toBeInTheDocument();
  });

  it("applies the custom accent class", () => {
    const { container } = render(
      <KanbanColumn title="Live" count={1} accentClass="bg-emerald-500" />,
    );

    expect(container.querySelector(".bg-emerald-500")).not.toBeNull();
  });

  it("falls back to the default accent class when none is supplied", () => {
    const { container } = render(<KanbanColumn title="Live" count={1} />);

    expect(container.querySelector(".bg-muted-foreground")).not.toBeNull();
  });

  it("renders children when content exists", () => {
    render(
      <KanbanColumn title="Live" count={2}>
        <li data-testid="card">Card 1</li>
        <li data-testid="card">Card 2</li>
      </KanbanColumn>,
    );

    expect(screen.getAllByTestId("card")).toHaveLength(2);
    expect(screen.queryByText("No data yet.")).not.toBeInTheDocument();
  });

  it("renders a single child (non-array path) correctly", () => {
    render(
      <KanbanColumn title="Live" count={1}>
        <li data-testid="card">Solo</li>
      </KanbanColumn>,
    );

    expect(screen.getByText("Solo")).toBeInTheDocument();
  });

  it("renders the empty state when all children entries are falsy", () => {
    render(
      <KanbanColumn title="Live" count={0}>
        {null}
        {false}
      </KanbanColumn>,
    );

    expect(screen.getByText("No data yet.")).toBeInTheDocument();
  });

  it("skips empty state when at least one truthy child appears in an array", () => {
    render(
      <KanbanColumn title="Live" count={1}>
        {null}
        <li data-testid="card">One</li>
      </KanbanColumn>,
    );

    expect(screen.queryByText("No data yet.")).not.toBeInTheDocument();
    expect(screen.getByText("One")).toBeInTheDocument();
  });
});
