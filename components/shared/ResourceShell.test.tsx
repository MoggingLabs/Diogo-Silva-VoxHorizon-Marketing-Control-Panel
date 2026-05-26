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

  it("renders bulkExtra in the bulk bar even with no bulkActions", () => {
    render(
      <ResourceShell
        title="Clients"
        selectedCount={1}
        bulkExtra={<button type="button">Export</button>}
      >
        <div />
      </ResourceShell>,
    );
    expect(screen.getByRole("region", { name: /bulk actions/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
  });

  describe("the `n` keyboard shortcut", () => {
    it("triggers onNew when newShortcut is on", async () => {
      const user = userEvent.setup();
      const onNew = vi.fn();
      render(
        <ResourceShell title="Clients" newLabel="New client" onNew={onNew} newShortcut>
          <div />
        </ResourceShell>,
      );
      await user.keyboard("n");
      expect(onNew).toHaveBeenCalledTimes(1);
    });

    it("does nothing when newShortcut is off", async () => {
      const user = userEvent.setup();
      const onNew = vi.fn();
      render(
        <ResourceShell title="Clients" onNew={onNew}>
          <div />
        </ResourceShell>,
      );
      await user.keyboard("n");
      expect(onNew).not.toHaveBeenCalled();
    });

    it("ignores `n` while typing in an input", async () => {
      const user = userEvent.setup();
      const onNew = vi.fn();
      render(
        <ResourceShell title="Clients" onNew={onNew} newShortcut>
          <input aria-label="field" />
        </ResourceShell>,
      );
      await user.click(screen.getByLabelText("field"));
      await user.keyboard("n");
      expect(onNew).not.toHaveBeenCalled();
    });

    it("ignores `n` when a modifier is held (e.g. cmd-n)", async () => {
      const user = userEvent.setup();
      const onNew = vi.fn();
      render(
        <ResourceShell title="Clients" onNew={onNew} newShortcut>
          <div />
        </ResourceShell>,
      );
      await user.keyboard("{Meta>}n{/Meta}");
      expect(onNew).not.toHaveBeenCalled();
    });

    it("does not attach the listener when onNew is absent", async () => {
      const user = userEvent.setup();
      // Should not throw even though newShortcut is on with no handler.
      render(
        <ResourceShell title="Clients" newShortcut>
          <div />
        </ResourceShell>,
      );
      await user.keyboard("n");
      // Nothing to assert beyond "no crash"; the guard returns early.
      expect(screen.getByRole("heading", { name: "Clients" })).toBeInTheDocument();
    });
  });
});
