"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { ConfirmArchive } from "@/components/shared/ConfirmArchive";
import { Button } from "@/components/ui/button";
import { archiveBrief, restoreBrief } from "@/lib/briefs-client";
import type { BriefFormat } from "@/lib/briefs-unified";

export type BriefArchiveButtonProps = {
  format: BriefFormat;
  briefId: string;
  /** True when the brief is currently archived (`deleted_at` set). */
  archived: boolean;
};

/**
 * Header-level Archive / Restore control for the brief detail pages (E3.2 /
 * #591). Mirrors `ArchivePipelineButton` but format-aware (image vs video).
 *
 * - Active brief: opens a confirm dialog, then soft-archives (sets
 *   `deleted_at`). The page refreshes into the archived state.
 * - Archived brief: a one-click Restore (clears `deleted_at`).
 *
 * Archive is reversible (the brief keeps its lineage + timeline), so the
 * confirm copy is cautionary, not alarming.
 */
export function BriefArchiveButton({ format, briefId, archived }: BriefArchiveButtonProps) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  if (archived) {
    const onRestore = async () => {
      if (restoring) return;
      setRestoring(true);
      try {
        await restoreBrief(format, briefId);
        toast.success("Brief restored");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not restore brief");
      } finally {
        setRestoring(false);
      }
    };

    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={restoring}
        onClick={() => void onRestore()}
        aria-label="Restore brief"
      >
        {restoring ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        Restore
      </Button>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setConfirmOpen(true)}
        aria-label="Archive brief"
      >
        <Archive className="h-3.5 w-3.5" aria-hidden="true" />
        Archive
      </Button>

      <ConfirmArchive
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        resourceName="brief"
        onConfirm={async () => {
          await archiveBrief(format, briefId);
        }}
        onSuccess={() => router.refresh()}
        successMessage="Brief archived"
      />
    </>
  );
}
