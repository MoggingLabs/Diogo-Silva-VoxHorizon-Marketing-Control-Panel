/**
 * Tests for the BulkExportButton (Makeover M7).
 *
 * Drives the real CSV/JSON serialize + browser-download path under jsdom: we
 * stub URL.createObjectURL/revokeObjectURL + anchor.click and assert a Blob is
 * produced, the filename is correct, and a success toast fires. Also covers the
 * disabled (no rows) state and the serialize-error toast.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

import { BulkExportButton } from "./BulkExportButton";
import type { CsvColumn } from "@/lib/export/csv";

type Row = { id: string; name: string };
const ROWS: Row[] = [
  { id: "1", name: "Acme" },
  { id: "2", name: "Globex" },
];
const COLUMNS: CsvColumn<Row>[] = [
  { header: "Name", value: (r) => r.name },
  { header: "Id", value: (r) => r.id },
];

// jsdom's Blob doesn't implement async .text(), so we capture the constructor
// args to read back the serialized content + type for assertions.
type CapturedBlob = { content: string; type: string };
let createdBlobs: CapturedBlob[] = [];
let clickSpy: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  createdBlobs = [];
  toastSuccess.mockReset();
  toastError.mockReset();
  vi.stubGlobal(
    "Blob",
    class MockBlob {
      content: string;
      type: string;
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        this.content = parts.map(String).join("");
        this.type = options?.type ?? "";
        createdBlobs.push({ content: this.content, type: this.type });
      }
    },
  );
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:mock");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  clickSpy = vi.fn<() => void>();
  // Intercept the transient anchor's click so jsdom doesn't try to navigate.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
    clickSpy();
  });
});

afterEach(() => {
  // `vi.stubGlobal` and `vi.spyOn` need different cleanup; both run here so a
  // leak can't bleed into another suite (e.g. BriefForm relies on fetch + the
  // real Blob / anchor click being intact).
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /export/i }));
}

describe("BulkExportButton", () => {
  it("exports CSV: builds a blob, clicks the anchor, and toasts the count", async () => {
    const user = userEvent.setup();
    render(<BulkExportButton rows={ROWS} columns={COLUMNS} filenameBase="clients" />);
    await openMenu(user);
    await user.click(await screen.findByText("Export as CSV"));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0]!.type).toContain("text/csv");
    expect(createdBlobs[0]!.content).toBe("Name,Id\r\nAcme,1\r\nGlobex,2");
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Exported 2 rows to CSV/));
  });

  it("exports JSON with the projected shape", async () => {
    const user = userEvent.setup();
    render(<BulkExportButton rows={[ROWS[0]!]} columns={COLUMNS} filenameBase="clients" />);
    await openMenu(user);
    await user.click(await screen.findByText("Export as JSON"));

    expect(createdBlobs[0]!.type).toContain("application/json");
    const parsed = JSON.parse(createdBlobs[0]!.content);
    expect(parsed).toEqual([{ Name: "Acme", Id: "1" }]);
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Exported 1 row to JSON/));
  });

  it("disables the trigger when there are no rows", () => {
    render(<BulkExportButton rows={[]} columns={COLUMNS} filenameBase="clients" />);
    expect(screen.getByRole("button", { name: /export/i })).toBeDisabled();
  });

  it("respects an explicit disabled prop", () => {
    render(<BulkExportButton rows={ROWS} columns={COLUMNS} filenameBase="c" disabled />);
    expect(screen.getByRole("button", { name: /export/i })).toBeDisabled();
  });

  it("renders a custom label", () => {
    render(
      <BulkExportButton rows={ROWS} columns={COLUMNS} filenameBase="c" label="Export selected" />,
    );
    expect(screen.getByRole("button", { name: /export selected/i })).toBeInTheDocument();
  });

  it("toasts an error when serialization throws", async () => {
    const user = userEvent.setup();
    const boomColumns: CsvColumn<Row>[] = [
      {
        header: "X",
        value: () => {
          throw new Error("kaboom");
        },
      },
    ];
    render(<BulkExportButton rows={ROWS} columns={boomColumns} filenameBase="c" />);
    await openMenu(user);
    await user.click(await screen.findByText("Export as CSV"));
    expect(toastError).toHaveBeenCalledWith("kaboom");
  });

  it("toasts a generic message when the thrown value is not an Error", async () => {
    const user = userEvent.setup();
    const weirdColumns: CsvColumn<Row>[] = [
      {
        header: "X",
        value: () => {
          throw "not an Error";
        },
      },
    ];
    render(<BulkExportButton rows={ROWS} columns={weirdColumns} filenameBase="c" />);
    await openMenu(user);
    await user.click(await screen.findByText("Export as JSON"));
    expect(toastError).toHaveBeenCalledWith("Export failed");
  });
});
