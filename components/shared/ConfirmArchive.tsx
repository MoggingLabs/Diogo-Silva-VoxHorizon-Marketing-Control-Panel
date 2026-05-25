"use client";

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ConfirmArchiveProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  /**
   * The thing(s) being archived. For a single item pass `count = 1` and a
   * `resourceName` like "brief"; for bulk pass the selected count. The copy
   * adapts automatically.
   */
  count?: number;
  /** Singular resource noun, e.g. "brief", "creative", "client". */
  resourceName?: string;

  /**
   * The soft-delete action. Resolve to toast success + close; throw to show
   * the error toast and keep the dialog open.
   */
  onConfirm: () => Promise<void> | void;
  onSuccess?: () => void;

  /** Override the title / body entirely if the default copy doesn't fit. */
  title?: React.ReactNode;
  description?: React.ReactNode;

  /** Use destructive styling + "Delete" verb (for hard-delete child rows). */
  destructive?: boolean;
  confirmLabel?: string;
  successMessage?: string;
};

/**
 * Confirmation dialog for soft-delete (archive) of one or many rows. Soft
 * deletes are reversible (restore), so the default tone is cautionary, not
 * alarming. Set `destructive` for the rare hard-delete of pure child config
 * rows. Handles both single and bulk via `count`.
 */
export function ConfirmArchive({
  open,
  onOpenChange,
  count = 1,
  resourceName = "item",
  onConfirm,
  onSuccess,
  title,
  description,
  destructive = false,
  confirmLabel,
  successMessage,
}: ConfirmArchiveProps) {
  const [pending, setPending] = React.useState(false);

  const verb = destructive ? "Delete" : "Archive";
  const noun = count === 1 ? resourceName : `${count} ${resourceName}s`;
  const defaultTitle = `${verb} ${count === 1 ? `this ${resourceName}` : noun}?`;
  const defaultDescription = destructive
    ? `This permanently deletes ${count === 1 ? `this ${resourceName}` : `these ${count} ${resourceName}s`}. This cannot be undone.`
    : `This archives ${count === 1 ? `this ${resourceName}` : `these ${count} ${resourceName}s`}. You can restore ${count === 1 ? "it" : "them"} later.`;

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      toast.success(
        successMessage ??
          `${count === 1 ? `${cap(resourceName)}` : `${count} ${resourceName}s`} ${destructive ? "deleted" : "archived"}`,
      );
      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not ${verb.toLowerCase()} ${noun}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (pending ? null : onOpenChange(o))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {destructive ? (
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
            ) : null}
            {title ?? defaultTitle}
          </DialogTitle>
          <DialogDescription>{description ?? defaultDescription}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={confirm}
            disabled={pending}
          >
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>{destructive ? "Deleting..." : "Archiving..."}</span>
              </>
            ) : (
              (confirmLabel ?? verb)
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
