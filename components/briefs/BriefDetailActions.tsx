"use client";

import * as React from "react";
import { Pencil } from "lucide-react";

import { BriefArchiveButton } from "@/components/briefs/BriefArchiveButton";
import { BriefEditDrawer } from "@/components/briefs/BriefEditDrawer";
import { Button } from "@/components/ui/button";
import type { Brief } from "@/lib/briefs";

export type BriefDetailActionsProps = {
  brief: Brief;
  /** True when the brief is archived (`deleted_at` set). */
  archived: boolean;
};

/**
 * Header action cluster for the image-brief detail page (E3.2 / #591): an Edit
 * button that opens the payload+status drawer, and the Archive/Restore control.
 * Editing is hidden while archived (restore first), matching the read-only
 * intent of an archived row.
 */
export function BriefDetailActions({ brief, archived }: BriefDetailActionsProps) {
  const [editOpen, setEditOpen] = React.useState(false);

  return (
    <div className="flex items-center gap-2">
      {!archived ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setEditOpen(true)}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          Edit
        </Button>
      ) : null}
      <BriefArchiveButton format="image" briefId={brief.id} archived={archived} />

      {!archived ? (
        <BriefEditDrawer open={editOpen} onOpenChange={setEditOpen} brief={brief} />
      ) : null}
    </div>
  );
}
