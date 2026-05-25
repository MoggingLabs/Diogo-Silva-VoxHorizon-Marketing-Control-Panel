"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { ConfirmArchive } from "@/components/shared/ConfirmArchive";
import { Button } from "@/components/ui/button";
import { archivePipeline, restorePipeline } from "@/lib/pipeline/client";

export type ArchivePipelineButtonProps = {
  pipelineId: string;
  /** True when the pipeline is currently archived (`deleted_at` set). */
  archived: boolean;
};

/**
 * Header-level Archive / Restore control for the pipeline detail page (#609).
 *
 * - Active pipeline: opens a confirm dialog, then soft-archives (sets
 *   `deleted_at`). After success the page refreshes into the archived state.
 * - Archived pipeline: a one-click Restore (clears `deleted_at`).
 *
 * Archive is a soft, reversible delete (the run keeps its timeline and can be
 * restored), so the confirm copy is cautionary, not alarming (handled by
 * ConfirmArchive's default tone).
 */
export function ArchivePipelineButton({ pipelineId, archived }: ArchivePipelineButtonProps) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  if (archived) {
    const onRestore = async () => {
      if (restoring) return;
      setRestoring(true);
      try {
        await restorePipeline(pipelineId);
        toast.success("Pipeline restored");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not restore pipeline");
      } finally {
        setRestoring(false);
      }
    };

    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-9 gap-1.5 self-start"
        disabled={restoring}
        onClick={() => void onRestore()}
        aria-label="Restore pipeline"
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
        className="min-h-9 gap-1.5 self-start"
        onClick={() => setConfirmOpen(true)}
        aria-label="Archive pipeline"
      >
        <Archive className="h-3.5 w-3.5" aria-hidden="true" />
        Archive
      </Button>

      <ConfirmArchive
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        resourceName="pipeline"
        onConfirm={async () => {
          await archivePipeline(pipelineId);
        }}
        onSuccess={() => router.refresh()}
        successMessage="Pipeline archived"
      />
    </>
  );
}
