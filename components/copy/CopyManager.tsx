"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import { CopyEditorDrawer, type CopyVariantLike } from "@/components/copy/CopyEditorDrawer";
import { ConfirmArchive } from "@/components/shared/ConfirmArchive";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { archiveCopy, restoreCopy } from "@/lib/copy/client";
import type { CopyFormatT } from "@/lib/copy/schemas";

/** The fields the manager renders + passes to the editor. */
export type ManagedCopyVariant = CopyVariantLike & {
  status: string | null;
  deleted_at: string | null;
};

export type CopyManagerProps = {
  format: CopyFormatT;
  creativeId: string;
  variants: ManagedCopyVariant[];
};

/**
 * Standalone copy CRUD panel (E3.3 / #592). Lists a creative's copy variants
 * with create / edit / archive / restore, outside the pipeline copy stage.
 * Format-aware: every mutation routes to the correct table via the copy client.
 * Editing re-arms compliance (the route resets to draft) — surfaced in the
 * editor copy.
 */
export function CopyManager({ format, creativeId, variants }: CopyManagerProps) {
  const router = useRouter();
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ManagedCopyVariant | null>(null);
  const [confirmArchive, setConfirmArchive] = React.useState<ManagedCopyVariant | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const nextIndex = React.useMemo(() => {
    const max = variants.reduce((m, v) => Math.max(m, v.variant_index), 0);
    return max + 1;
  }, [variants]);

  function openCreate() {
    setEditing(null);
    setEditorOpen(true);
  }

  function openEdit(v: ManagedCopyVariant) {
    setEditing(v);
    setEditorOpen(true);
  }

  async function onRestore(v: ManagedCopyVariant) {
    setBusyId(v.id);
    try {
      await restoreCopy(format, v.id);
      toast.success("Copy variant restored");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not restore variant");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Copy variants</h2>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>New variant</span>
        </Button>
      </div>

      {variants.length === 0 ? (
        <p className="rounded-md border border-border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
          No copy variants yet.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {variants.map((v) => {
            const archived = Boolean(v.deleted_at);
            return (
              <li
                key={v.id}
                className="flex items-start justify-between gap-4 p-3"
                data-testid="copy-row"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      #{v.variant_index}
                    </span>
                    <span className="text-xs capitalize text-muted-foreground">{v.platform}</span>
                    {v.status ? <StatusBadge status={v.status} /> : null}
                    {archived ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        Archived
                      </span>
                    ) : null}
                  </div>
                  {v.headline ? <p className="truncate text-sm font-medium">{v.headline}</p> : null}
                  {v.body ? (
                    <p className="line-clamp-2 text-sm text-muted-foreground">{v.body}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {archived ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      disabled={busyId === v.id}
                      onClick={() => void onRestore(v)}
                      aria-label={`Restore variant ${v.variant_index}`}
                    >
                      <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
                      Restore
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEdit(v)}
                        aria-label={`Edit variant ${v.variant_index}`}
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => setConfirmArchive(v)}
                        aria-label={`Archive variant ${v.variant_index}`}
                      >
                        <Archive className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <CopyEditorDrawer
        open={editorOpen}
        onOpenChange={setEditorOpen}
        format={format}
        creativeId={creativeId}
        variant={editing}
        nextIndex={nextIndex}
      />

      <ConfirmArchive
        open={confirmArchive !== null}
        onOpenChange={(o) => (o ? null : setConfirmArchive(null))}
        resourceName="copy variant"
        onConfirm={async () => {
          if (confirmArchive) await archiveCopy(format, confirmArchive.id);
        }}
        onSuccess={() => router.refresh()}
        successMessage="Copy variant archived"
      />
    </section>
  );
}
