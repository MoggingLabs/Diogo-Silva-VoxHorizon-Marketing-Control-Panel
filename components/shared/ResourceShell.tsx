"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { hasModifier, isTypingTarget } from "@/lib/keyboard";
import { cn } from "@/lib/utils";

export type BulkAction = {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  destructive?: boolean;
};

export type ResourceShellProps = {
  /** Page title. */
  title: React.ReactNode;
  /** Optional one-line description under the title. */
  description?: React.ReactNode;

  /** "New <resource>" primary action. Omit to hide the button. */
  newLabel?: string;
  onNew?: () => void;
  /**
   * Enable the global `n` shortcut to trigger `onNew` (Makeover M7 keyboard
   * nav). Ignored when `onNew` is absent or focus is in a text input, so it
   * never hijacks typing. Off by default to stay unobtrusive.
   */
  newShortcut?: boolean;

  /** Extra header controls (e.g. format tabs, export) to the left of New. */
  headerActions?: React.ReactNode;

  /**
   * Bulk action bar. When `selectedCount > 0` a sticky bar appears above the
   * content with the supplied actions + a clear-selection control.
   */
  selectedCount?: number;
  bulkActions?: BulkAction[];
  /**
   * Extra custom controls rendered in the bulk bar alongside the buttons (e.g.
   * the `BulkExportButton` dropdown, which can't be expressed as a plain
   * `BulkAction`). Shown whenever the bulk bar is visible.
   */
  bulkExtra?: React.ReactNode;
  onClearSelection?: () => void;

  /** The DataTable (or any content) for this resource. */
  children: React.ReactNode;

  className?: string;
};

/**
 * Standard page scaffold for a CRUD resource list: a title block with a
 * primary "New" action, an optional bulk-action bar that appears when rows are
 * selected, and a content slot (typically a `DataTable`). Keeps every resource
 * list visually consistent.
 */
export function ResourceShell({
  title,
  description,
  newLabel,
  onNew,
  newShortcut = false,
  headerActions,
  selectedCount = 0,
  bulkActions = [],
  bulkExtra,
  onClearSelection,
  children,
  className,
}: ResourceShellProps) {
  // `n` opens the "New" flow. Guarded so it never fires while typing, with a
  // modifier held, or when there's no New action to trigger.
  React.useEffect(() => {
    if (!newShortcut || !onNew) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "n" && e.key !== "N") return;
      if (hasModifier(e) || isTypingTarget(e.target)) return;
      e.preventDefault();
      onNew?.();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newShortcut, onNew]);

  return (
    <main className={cn("mx-auto w-full max-w-7xl px-4 py-6 sm:px-6", className)}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {headerActions}
          {onNew ? (
            <Button onClick={onNew}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>{newLabel ?? "New"}</span>
            </Button>
          ) : null}
        </div>
      </div>

      {selectedCount > 0 && (bulkActions.length > 0 || bulkExtra) ? (
        <div
          className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2"
          role="region"
          aria-label="Bulk actions"
        >
          <span className="text-sm font-medium text-foreground">{selectedCount} selected</span>
          <div className="flex flex-wrap items-center gap-2">
            {bulkActions.map((action) => (
              <Button
                key={action.label}
                size="sm"
                variant={action.destructive ? "destructive" : "outline"}
                onClick={action.onClick}
              >
                {action.icon}
                <span>{action.label}</span>
              </Button>
            ))}
            {bulkExtra}
          </div>
          {onClearSelection ? (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={onClearSelection}>
              Clear
            </Button>
          ) : null}
        </div>
      ) : null}

      {children}
    </main>
  );
}
