"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toCsv, toJson, type CsvColumn } from "@/lib/export/csv";
import { downloadTextFile, EXPORT_MIME, exportFilename } from "@/lib/export/download";

export type BulkExportButtonProps<T> = {
  /** The rows to export (typically the current selection). */
  rows: T[];
  /** Column projection shared by the CSV + JSON output. */
  columns: CsvColumn<T>[];
  /**
   * Filename stem, e.g. "clients" -> `clients-2026-05-26.csv`. The export date
   * is appended automatically.
   */
  filenameBase: string;
  /** Disable the trigger (e.g. nothing selected). */
  disabled?: boolean;
  /** Button label; defaults to "Export". */
  label?: string;
  /** Button size passthrough. */
  size?: "default" | "sm" | "lg" | "icon";
};

/**
 * Bulk export control for a DataTable selection. A dropdown offering CSV or
 * JSON; both serialize the supplied rows client-side (no server round trip)
 * and download immediately. Used in the ResourceShell bulk-action bar so every
 * list gets consistent export. Toasts the row count on success and surfaces any
 * serialization error rather than failing silently.
 */
export function BulkExportButton<T>({
  rows,
  columns,
  filenameBase,
  disabled = false,
  label = "Export",
  size = "sm",
}: BulkExportButtonProps<T>) {
  const doExport = React.useCallback(
    (format: "csv" | "json") => {
      try {
        const content = format === "csv" ? toCsv(rows, columns) : toJson(rows, columns);
        downloadTextFile(exportFilename(filenameBase, format), content, EXPORT_MIME[format]);
        toast.success(
          `Exported ${rows.length} ${rows.length === 1 ? "row" : "rows"} to ${format.toUpperCase()}`,
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Export failed");
      }
    },
    [rows, columns, filenameBase],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size} variant="outline" disabled={disabled || rows.length === 0}>
          <Download className="h-4 w-4" aria-hidden="true" />
          <span>{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => doExport("csv")}>Export as CSV</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => doExport("json")}>Export as JSON</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
