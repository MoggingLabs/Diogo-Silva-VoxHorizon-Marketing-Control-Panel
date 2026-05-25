/**
 * Tests for ResourceShell: title/description, the New button, the bulk-action
 * bar (visible only when selectedCount > 0), bulk action + clear callbacks,
 * and rendering children.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResourceShell } from "./ResourceShell";

afterEach(() => {
  vi.clearAllMocks();
});

describe("ResourceShell", () => {
  it("renders title, description, the New button, and children", async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    render(
      <ResourceShell
        title="Clients"
        description="Manage clients"
        newLabel="New client"
        onNew={onNew}
      >
        <div data-testid="content">table</div>
      </ResourceShell>,
    );
    expect(screen.getByRole("heading", { name: "Clients" })).toBeInTheDocument();
    expect(screen.getByText("Manage clients")).toBeInTheDocument();
    expect(screen.getByTestId("content")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /new client/i }));
    expect(onNew).toHaveBeenCalled();
  });

  it("hides the New button when onNew is omitted", () => {
    render(
      <ResourceShell title="Clients">
        <div />
      </ResourceShell>,
    );
    expect(screen.queryByRole("button", { name: /new/i })).not.toBeInTheDocument();
  });

  it("hides the bulk bar when nothing is selected", () => {
    render(
      <ResourceShell
        title="Clients"
        selectedCount={0}
        bulkActions={[{ label: "Archive", onClick: vi.fn() }]}
      >
        <div />
      </ResourceShell>,
    );
    expect(screen.queryByRole("region", { name: /bulk actions/i })).not.toBeInTheDocument();
  });

  it("shows the bulk bar and wires actions + clear when rows are selected", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    const onClear = vi.fn();
    render(
      <ResourceShell
        title="Clients"
        selectedCount={2}
        bulkActions={[{ label: "Archive", onClick: onArchive, destructive: true }]}
        onClearSelection={onClear}
      >
        <div />
      </ResourceShell>,
    );
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalled();
  });
});
