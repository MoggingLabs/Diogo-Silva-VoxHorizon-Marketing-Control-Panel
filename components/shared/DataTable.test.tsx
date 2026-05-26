/**
 * Tests for the generic DataTable.
 *
 * Covers: rendering rows + columns, empty + loading states, client-side
 * search / filter / sort / pagination, bulk selection (controlled +
 * uncontrolled), per-row action menu, URL-state sync (sort/search/page/filter),
 * the `parseTableState` helper, server mode, and row-click.
 */
import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
let currentParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/widgets",
  useSearchParams: () => currentParams,
}));

import { DataTable, parseTableState, type DataTableColumn } from "./DataTable";

type Row = { id: string; name: string; status: string; score: number };

const ROWS: Row[] = [
  { id: "1", name: "Charlie", status: "active", score: 30 },
  { id: "2", name: "Alpha", status: "draft", score: 10 },
  { id: "3", name: "Bravo", status: "active", score: 20 },
];

const COLUMNS: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", cell: (r) => r.name, sortable: true, accessor: (r) => r.name },
  { id: "status", header: "Status", cell: (r) => r.status },
  {
    id: "score",
    header: "Score",
    cell: (r) => r.score,
    sortable: true,
    accessor: (r) => r.score,
    align: "right",
  },
];

beforeEach(() => {
  replace.mockClear();
  currentParams = new URLSearchParams();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("parseTableState", () => {
  it("parses sort/dir/q/page and namespaced filters", () => {
    const p = new URLSearchParams("sort=name&dir=desc&q=foo&page=3&f_status=active");
    const state = parseTableState(p, ["status"]);
    expect(state).toEqual({
      sort: "name",
      dir: "desc",
      q: "foo",
      page: 3,
      filters: { status: "active" },
    });
  });

  it("defaults dir to asc and page to 1 on garbage input", () => {
    const p = new URLSearchParams("dir=sideways&page=-4");
    const state = parseTableState(p);
    expect(state.dir).toBe("asc");
    expect(state.page).toBe(1);
    expect(state.sort).toBeNull();
  });
});

describe("DataTable rendering", () => {
  it("renders columns and rows", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} />);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Charlie")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("3 records")).toBeInTheDocument();
  });

  it("shows the empty state when there is no data", () => {
    render(
      <DataTable columns={COLUMNS} data={[]} getRowId={(r) => r.id} emptyMessage="Nothing here" />,
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("shows the loading state", () => {
    render(<DataTable columns={COLUMNS} data={[]} getRowId={(r) => r.id} loading />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });
});

describe("DataTable client behaviour", () => {
  it("filters by search query", () => {
    currentParams = new URLSearchParams("q=alp");
    render(<DataTable columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} searchable />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Charlie")).not.toBeInTheDocument();
  });

  it("filters by enum filter on row[id]", () => {
    currentParams = new URLSearchParams("f_status=draft");
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(r) => r.id}
        filters={[
          {
            id: "status",
            label: "Status",
            options: [
              { value: "active", label: "Active" },
              { value: "draft", label: "Draft" },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Charlie")).not.toBeInTheDocument();
  });

  it("sorts ascending then writes sort/dir to the URL on header click", async () => {
    const user = userEvent.setup();
    currentParams = new URLSearchParams("sort=name&dir=asc");
    render(<DataTable columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} />);

    // With sort=name asc, the first body row should be Alpha.
    const rows = screen.getAllByRole("row");
    // rows[0] is the header row.
    expect(within(rows[1]!).getByText("Alpha")).toBeInTheDocument();

    // Clicking the already-sorted column flips to desc via the URL.
    await user.click(screen.getByRole("button", { name: /sort by name/i }));
    expect(replace).toHaveBeenCalled();
    const url = replace.mock.calls.at(-1)?.[0] as string;
    expect(url).toContain("sort=name");
    expect(url).toContain("dir=desc");
  });

  it("pushes the search query to the URL on Enter", async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} searchable />);
    const input = screen.getByLabelText("Search table");
    await user.type(input, "bravo{Enter}");
    expect(replace).toHaveBeenCalled();
    expect(replace.mock.calls.at(-1)?.[0]).toContain("q=bravo");
  });

  it("paginates and exposes prev/next controls", () => {
    const many: Row[] = Array.from({ length: 25 }, (_, i) => ({
      id: String(i),
      name: `Row ${i}`,
      status: "active",
      score: i,
    }));
    currentParams = new URLSearchParams("page=2");
    render(<DataTable columns={COLUMNS} data={many} getRowId={(r) => r.id} pageSize={20} />);
    expect(screen.getByText(/page 2 of 2/i)).toBeInTheDocument();
    // page 2 shows the 21st row (index 20)
    expect(screen.getByText("Row 20")).toBeInTheDocument();
    expect(screen.queryByText("Row 0")).not.toBeInTheDocument();
  });
});

describe("DataTable selection", () => {
  it("supports uncontrolled selection and shows the selected count", async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} selectable />);
    const rowChecks = screen.getAllByLabelText(/select row/i);
    await user.click(rowChecks[0]!);
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("reports controlled selection changes and select-all-on-page", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(r) => r.id}
        selectable
        selectedIds={[]}
        onSelectionChange={onSelectionChange}
      />,
    );
    await user.click(screen.getByLabelText(/select all rows on this page/i));
    expect(onSelectionChange).toHaveBeenCalledWith(["1", "2", "3"]);
  });

  it("toggles select-all back off when every page row is already selected", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(r) => r.id}
        selectable
        selectedIds={["1", "2", "3"]}
        onSelectionChange={onSelectionChange}
      />,
    );
    await user.click(screen.getByLabelText(/select all rows on this page/i));
    // Header was 'all selected' so clicking deselects every page row.
    expect(onSelectionChange).toHaveBeenCalledWith([]);
  });
});

describe("DataTable row actions + row click", () => {
  it("invokes a per-row action from the menu", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(r) => r.id}
        rowActions={[{ label: "Archive", onSelect }]}
      />,
    );
    const menuButtons = screen.getAllByRole("button", { name: /row actions/i });
    await user.click(menuButtons[0]!);
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(onSelect).toHaveBeenCalledWith(ROWS[0]);
  });

  it("calls onRowClick when a row is clicked", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <DataTable columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} onRowClick={onRowClick} />,
    );
    await user.click(screen.getByText("Charlie"));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });
});

describe("DataTable URL writers", () => {
  it("changes a filter via the Select and writes f_<id> to the URL", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(r) => r.id}
        filters={[
          {
            id: "status",
            label: "Status",
            options: [
              { value: "active", label: "Active" },
              { value: "draft", label: "Draft" },
            ],
          },
        ]}
      />,
    );
    await user.click(screen.getByLabelText("Status"));
    await user.click(await screen.findByRole("option", { name: "Draft" }));
    expect(replace).toHaveBeenCalled();
    expect(replace.mock.calls.at(-1)?.[0]).toContain("f_status=draft");
  });

  it("clears the search query on blur when emptied", async () => {
    const user = userEvent.setup();
    currentParams = new URLSearchParams("q=foo");
    render(<DataTable columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} searchable />);
    const input = screen.getByLabelText("Search table");
    await user.clear(input);
    await user.tab();
    expect(replace).toHaveBeenCalled();
    // emptied query removes q from the URL
    expect(replace.mock.calls.at(-1)?.[0]).not.toContain("q=");
  });

  it("navigates pages via prev/next and clamps page 1 out of the URL", async () => {
    const user = userEvent.setup();
    const many: Row[] = Array.from({ length: 25 }, (_, i) => ({
      id: String(i),
      name: `Row ${i}`,
      status: "active",
      score: i,
    }));
    currentParams = new URLSearchParams("page=2");
    render(<DataTable columns={COLUMNS} data={many} getRowId={(r) => r.id} pageSize={20} />);
    await user.click(screen.getByRole("button", { name: /previous page/i }));
    // going back to page 1 drops the page param entirely
    expect(replace.mock.calls.at(-1)?.[0]).not.toContain("page=");
  });

  it("writes ?page=N when paging forward past page 1", async () => {
    const user = userEvent.setup();
    const many: Row[] = Array.from({ length: 25 }, (_, i) => ({
      id: String(i),
      name: `Row ${i}`,
      status: "active",
      score: i,
    }));
    render(<DataTable columns={COLUMNS} data={many} getRowId={(r) => r.id} pageSize={20} />);
    await user.click(screen.getByRole("button", { name: /next page/i }));
    expect(replace.mock.calls.at(-1)?.[0]).toContain("page=2");
  });

  it("clears the filter when 'All' is reselected (drops f_<id>)", async () => {
    const user = userEvent.setup();
    currentParams = new URLSearchParams("f_status=active");
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(r) => r.id}
        filters={[
          {
            id: "status",
            label: "Status",
            options: [
              { value: "active", label: "Active" },
              { value: "draft", label: "Draft" },
            ],
          },
        ]}
      />,
    );
    await user.click(screen.getByLabelText("Status"));
    await user.click(await screen.findByRole("option", { name: /all status/i }));
    expect(replace.mock.calls.at(-1)?.[0]).not.toContain("f_status=");
  });
});

describe("DataTable edge cases", () => {
  it("sorts rows with null accessor values without crashing", () => {
    const rows = [
      { id: "a", name: "Zed", status: "x", score: 1 },
      { id: "b", name: null as unknown as string, status: "x", score: 2 },
    ];
    currentParams = new URLSearchParams("sort=name&dir=asc");
    render(
      <DataTable
        columns={[
          {
            id: "name",
            header: "Name",
            cell: (r) => r.name ?? "-",
            sortable: true,
            accessor: (r) => r.name,
          },
        ]}
        data={rows}
        getRowId={(r) => r.id}
      />,
    );
    // nulls sort first
    const bodyRows = screen.getAllByRole("row");
    expect(bodyRows.length).toBe(3); // header + 2
  });

  it("disables a row action when its disabled predicate returns true", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(r) => r.id}
        rowActions={[{ label: "Edit", onSelect, disabled: () => true, destructive: true }]}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: /row actions/i })[0]!);
    const item = await screen.findByRole("menuitem", { name: "Edit" });
    expect(item).toHaveAttribute("aria-disabled", "true");
  });
});

describe("DataTable keyboard navigation", () => {
  function renderKbd(extra: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) {
    render(
      <DataTable columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} keyboardNav {...extra} />,
    );
    // The tbody owns the keydown handler. fireEvent dispatches straight to it,
    // which is the reliable way to drive a handler on a non-focusable element.
    return screen.getAllByRole("rowgroup")[1]!; // [0] thead, [1] tbody
  }

  function focusedText(): string | undefined {
    const focused = screen
      .getAllByRole("row")
      .find((r) => r.getAttribute("data-focused") === "true");
    return focused
      ? (within(focused).getAllByRole("cell")[0]?.textContent ?? undefined)
      : undefined;
  }

  it("moves row focus with ArrowDown / ArrowUp", () => {
    const body = renderKbd();
    fireEvent.keyDown(body, { key: "ArrowDown" }); // first lands on row 0
    expect(focusedText()).toBe("Charlie");
    fireEvent.keyDown(body, { key: "ArrowDown" });
    expect(focusedText()).toBe("Alpha");
    fireEvent.keyDown(body, { key: "ArrowUp" });
    expect(focusedText()).toBe("Charlie");
  });

  it("jumps to first/last with Home/End and clamps at the edges", () => {
    const body = renderKbd();
    fireEvent.keyDown(body, { key: "End" });
    expect(focusedText()).toBe("Bravo");
    fireEvent.keyDown(body, { key: "ArrowDown" }); // clamps at last
    expect(focusedText()).toBe("Bravo");
    fireEvent.keyDown(body, { key: "Home" });
    expect(focusedText()).toBe("Charlie");
    fireEvent.keyDown(body, { key: "ArrowUp" }); // clamps at first
    expect(focusedText()).toBe("Charlie");
  });

  it("triggers onEditRow with Enter and with 'e'", () => {
    const onEditRow = vi.fn();
    const body = renderKbd({ onEditRow });
    fireEvent.keyDown(body, { key: "ArrowDown" });
    fireEvent.keyDown(body, { key: "Enter" });
    expect(onEditRow).toHaveBeenCalledWith(ROWS[0]);
    onEditRow.mockClear();
    fireEvent.keyDown(body, { key: "ArrowDown" });
    fireEvent.keyDown(body, { key: "e" });
    expect(onEditRow).toHaveBeenCalledWith(ROWS[1]);
  });

  it("does nothing on Enter/e when no row is focused", () => {
    const onEditRow = vi.fn();
    const body = renderKbd({ onEditRow });
    fireEvent.keyDown(body, { key: "e" });
    fireEvent.keyDown(body, { key: "Enter" });
    expect(onEditRow).not.toHaveBeenCalled();
  });

  it("falls back to onRowClick when onEditRow is absent", () => {
    const onRowClick = vi.fn();
    const body = renderKbd({ onRowClick });
    fireEvent.keyDown(body, { key: "ArrowDown" });
    fireEvent.keyDown(body, { key: "Enter" });
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it("toggles selection with Space when selectable", () => {
    const onSelectionChange = vi.fn();
    const body = renderKbd({ selectable: true, selectedIds: [], onSelectionChange });
    fireEvent.keyDown(body, { key: "ArrowDown" });
    fireEvent.keyDown(body, { key: " " });
    expect(onSelectionChange).toHaveBeenCalledWith(["1"]);
  });

  it("does not toggle selection with Space when not selectable", () => {
    const onSelectionChange = vi.fn();
    const body = renderKbd({ selectable: false, onSelectionChange });
    fireEvent.keyDown(body, { key: "ArrowDown" });
    fireEvent.keyDown(body, { key: " " });
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("ignores Space when selectable but no row is focused", () => {
    const onSelectionChange = vi.fn();
    const body = renderKbd({ selectable: true, selectedIds: [], onSelectionChange });
    fireEvent.keyDown(body, { key: " " });
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("clears focus on Escape", () => {
    const body = renderKbd();
    fireEvent.keyDown(body, { key: "ArrowDown" });
    expect(focusedText()).toBe("Charlie");
    fireEvent.keyDown(body, { key: "Escape" });
    expect(focusedText()).toBeUndefined();
  });

  it("Escape with no focus is a no-op (does not prevent default)", () => {
    const body = renderKbd();
    // No row focused yet; Escape should simply do nothing.
    fireEvent.keyDown(body, { key: "Escape" });
    expect(focusedText()).toBeUndefined();
  });

  it("ignores an unhandled key", () => {
    const onEditRow = vi.fn();
    const body = renderKbd({ onEditRow });
    fireEvent.keyDown(body, { key: "ArrowDown" });
    fireEvent.keyDown(body, { key: "x" });
    expect(onEditRow).not.toHaveBeenCalled();
    expect(focusedText()).toBe("Charlie");
  });

  it("does not attach the handler when keyboardNav is off", () => {
    const onEditRow = vi.fn();
    render(
      <DataTable columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} onEditRow={onEditRow} />,
    );
    const body = screen.getAllByRole("rowgroup")[1]!;
    fireEvent.keyDown(body, { key: "ArrowDown" });
    fireEvent.keyDown(body, { key: "Enter" });
    expect(onEditRow).not.toHaveBeenCalled();
    expect(focusedText()).toBeUndefined();
  });

  it("does nothing on keydown when there are no rows", () => {
    const onEditRow = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        data={[]}
        getRowId={(r) => r.id}
        keyboardNav
        onEditRow={onEditRow}
      />,
    );
    const body = screen.getAllByRole("rowgroup")[1]!;
    fireEvent.keyDown(body, { key: "ArrowDown" });
    fireEvent.keyDown(body, { key: "Enter" });
    fireEvent.keyDown(body, { key: "Escape" });
    expect(onEditRow).not.toHaveBeenCalled();
  });

  it("clamps the focused index when the page set shrinks", () => {
    function Wrap({ data }: { data: Row[] }) {
      return <DataTable columns={COLUMNS} data={data} getRowId={(r) => r.id} keyboardNav />;
    }
    const { rerender } = render(<Wrap data={ROWS} />);
    const body = screen.getAllByRole("rowgroup")[1]!;
    fireEvent.keyDown(body, { key: "End" });
    expect(focusedText()).toBe("Bravo"); // index 2
    // Shrink the data so the previously-focused index is out of range; the
    // effect clamps to the new last row.
    rerender(<Wrap data={[ROWS[0]!]} />);
    expect(focusedText()).toBe("Charlie");
    // Now drain the data entirely; focus clears.
    rerender(<Wrap data={[]} />);
    expect(focusedText()).toBeUndefined();
  });

  it("updates the focused index when a row receives focus (onFocus)", () => {
    const onEditRow = vi.fn();
    renderKbd({ onEditRow });
    const rows = screen.getAllByRole("row");
    // Focus the third data row directly (rows[3] => data row index 2 = Bravo).
    fireEvent.focus(rows[3]!);
    const body = screen.getAllByRole("rowgroup")[1]!;
    fireEvent.keyDown(body, { key: "Enter" });
    expect(onEditRow).toHaveBeenCalledWith(ROWS[2]);
  });
});

describe("DataTable server mode", () => {
  it("does not re-sort data and reports state changes", () => {
    const onStateChange = vi.fn();
    currentParams = new URLSearchParams("sort=name&dir=desc");
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(r) => r.id}
        serverMode
        total={99}
        pageCount={5}
        onStateChange={onStateChange}
      />,
    );
    // server mode keeps the supplied order (Charlie first)
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]!).getByText("Charlie")).toBeInTheDocument();
    expect(screen.getByText("99 records")).toBeInTheDocument();
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ sort: "name", dir: "desc" }),
    );
  });
});
