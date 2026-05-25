"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useFormContext } from "react-hook-form";
import { Archive, ArchiveRestore, Pencil } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { ConfirmArchive } from "@/components/shared/ConfirmArchive";
import { CrudDialog } from "@/components/shared/CrudDialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  archiveLaunch,
  restoreLaunch,
  updateLaunch,
  type LaunchFormat,
} from "@/lib/launches/client";

/**
 * Launch package detail-header actions (E5.1 / #595): edit the operator
 * annotation, soft-archive, or restore. The launch DECISION is NOT here — it
 * stays in the ApprovalGate against the decision route which re-derives the
 * hard gate. Works for both formats via the `format` prop.
 */

const NotesForm = z.object({
  decided_notes: z.string().max(5000),
});
type NotesFormT = z.infer<typeof NotesForm>;

export type LaunchPackageActionsProps = {
  format: LaunchFormat;
  launchId: string;
  /** Current operator annotation, prefilled into the edit dialog. */
  decidedNotes: string | null;
  /** When true the package is archived: show Restore instead of Archive/Edit. */
  archived: boolean;
};

export function LaunchPackageActions({
  format,
  launchId,
  decidedNotes,
  archived,
}: LaunchPackageActionsProps) {
  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);

  const onEdit = React.useCallback(
    async (values: NotesFormT) => {
      await updateLaunch(format, launchId, { decided_notes: values.decided_notes || null });
      router.refresh();
    },
    [format, launchId, router],
  );

  const onArchive = React.useCallback(async () => {
    await archiveLaunch(format, launchId);
    router.refresh();
  }, [format, launchId, router]);

  const onRestore = React.useCallback(async () => {
    setRestoring(true);
    try {
      await restoreLaunch(format, launchId);
      toast.success("Launch restored");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not restore launch");
    } finally {
      setRestoring(false);
    }
  }, [format, launchId, router]);

  if (archived) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={restoring}
        onClick={() => void onRestore()}
        aria-label="Restore launch"
      >
        <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
        Restore
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setEditOpen(true)}
      >
        <Pencil className="h-4 w-4" aria-hidden="true" />
        Edit notes
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5 text-destructive hover:text-destructive"
        onClick={() => setArchiveOpen(true)}
        aria-label="Archive launch"
      >
        <Archive className="h-4 w-4" aria-hidden="true" />
        Archive
      </Button>

      <CrudDialog<NotesFormT>
        open={editOpen}
        onOpenChange={setEditOpen}
        title="Edit launch notes"
        description="Free-form operator annotation on this launch package."
        schema={NotesForm}
        defaultValues={{ decided_notes: decidedNotes ?? "" }}
        onSubmit={onEdit}
        successMessage="Launch notes saved"
      >
        <div className="space-y-1.5">
          <Label htmlFor="decided_notes">Notes</Label>
          <NotesField />
        </div>
      </CrudDialog>

      <ConfirmArchive
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        resourceName="launch"
        onConfirm={onArchive}
        successMessage="Launch archived"
      />
    </div>
  );
}

/**
 * The notes textarea, wired to the CrudDialog's react-hook-form context. Kept a
 * small inner component so it can read `useFormContext` from CrudDialog's
 * FormProvider.
 */
function NotesField() {
  const { register } = useFormContext<NotesFormT>();
  return (
    <Textarea
      id="decided_notes"
      rows={4}
      placeholder="Add a note about this launch..."
      {...register("decided_notes")}
    />
  );
}
