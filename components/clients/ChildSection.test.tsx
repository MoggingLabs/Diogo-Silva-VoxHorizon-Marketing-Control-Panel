/**
 * Tests for the generic ChildSection (1:many client child CRUD card list).
 *
 * Covers: empty state, rendering rows, Add -> createChild, Edit -> updateChild
 * (with toValues seeding + toBody mapping), and Archive -> archiveChild.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn() }),
}));

const createChild = vi.fn<(...a: unknown[]) => unknown>(() =>
  Promise.resolve({ item: { id: "new" } }),
);
const updateChild = vi.fn<(...a: unknown[]) => unknown>(() => Promise.resolve({}));
const archiveChild = vi.fn<(...a: unknown[]) => unknown>(() => Promise.resolve({}));
vi.mock("@/lib/clients/api", () => ({
  createChild: (...a: unknown[]) => createChild(...a),
  updateChild: (...a: unknown[]) => updateChild(...a),
  archiveChild: (...a: unknown[]) => archiveChild(...a),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ChildSection } from "./ChildSection";
import { TextField } from "./fields";

const schema = z.object({ service_name: z.string().min(1) });
type Row = { id: string; service_name: string };

function renderSection(rows: Row[]) {
  return render(
    <ChildSection<Row, z.infer<typeof schema>>
      clientId="c1"
      childKey="services"
      resourceName="service"
      title="Services"
      rows={rows}
      schema={schema}
      emptyValues={{ service_name: "" }}
      toValues={(r) => ({ service_name: r.service_name })}
      renderFields={() => <TextField name="service_name" label="Service name" />}
      renderRow={(r) => <span>{r.service_name}</span>}
    />,
  );
}

afterEach(() => vi.clearAllMocks());

describe("ChildSection", () => {
  it("shows the empty state when there are no rows", () => {
    renderSection([]);
    expect(screen.getByText(/no services yet/i)).toBeInTheDocument();
  });

  it("renders existing rows", () => {
    renderSection([{ id: "s1", service_name: "Roof repair" }]);
    expect(screen.getByText("Roof repair")).toBeInTheDocument();
  });

  it("creates a child via the Add dialog", async () => {
    renderSection([]);
    await userEvent.click(screen.getByRole("button", { name: /add/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Service name"), "Gutters");
    await userEvent.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(createChild).toHaveBeenCalledWith("c1", "services", { service_name: "Gutters" }),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("edits a child via the row Edit dialog (seeded from the row)", async () => {
    renderSection([{ id: "s1", service_name: "Roof repair" }]);
    await userEvent.click(screen.getByRole("button", { name: /edit service/i }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Service name");
    expect(input).toHaveValue("Roof repair");
    await userEvent.clear(input);
    await userEvent.type(input, "Roof replacement");
    await userEvent.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(updateChild).toHaveBeenCalledWith("c1", "services", "s1", {
        service_name: "Roof replacement",
      }),
    );
  });

  it("archives a child via the confirm dialog", async () => {
    renderSection([{ id: "s1", service_name: "Roof repair" }]);
    await userEvent.click(screen.getByRole("button", { name: /archive service/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(archiveChild).toHaveBeenCalledWith("c1", "services", "s1"));
  });
});
