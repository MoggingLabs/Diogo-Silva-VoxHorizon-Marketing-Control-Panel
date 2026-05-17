"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, OctagonAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cancelPipeline } from "@/lib/pipeline/client";

export type CancelPipelineButtonProps = {
  pipelineId: string;
};

/**
 * Header-level "Cancel pipeline" CTA (PF-G-1).
 *
 * Sits next to the pipeline title and opens a confirmation modal before
 * POSTing to `/api/pipelines/[id]/cancel`. The button is mounted from the
 * page wrapper only when the pipeline is in a non-terminal status — the
 * parent gates on `status !== 'done' && status !== 'cancelled'`.
 *
 * After a successful cancel we `router.refresh()` so the detail page
 * re-renders with `status='cancelled'`. Errors stay inline inside the modal
 * so the operator can retry without losing the dialog state.
 */
export function CancelPipelineButton({ pipelineId }: CancelPipelineButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await cancelPipeline(pipelineId);
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-9 gap-1.5 self-start text-destructive hover:text-destructive"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        aria-label="Cancel pipeline"
      >
        <OctagonAlert className="h-3.5 w-3.5" aria-hidden="true" />
        Cancel pipeline
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this pipeline?</DialogTitle>
            <DialogDescription>
              This stops the workflow and marks the pipeline as cancelled. Any in-flight worker
              tasks finish their current step and exit on the next checkpoint. This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <p
              role="alert"
              className="break-words rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
              className="min-h-11 sm:min-h-9"
            >
              Keep running
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void onConfirm()}
              disabled={submitting}
              className="min-h-11 gap-1.5 sm:min-h-9"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Cancelling…
                </>
              ) : (
                "Cancel pipeline"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
