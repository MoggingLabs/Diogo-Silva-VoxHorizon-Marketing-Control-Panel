"use client";

import * as React from "react";
import { Pencil } from "lucide-react";

import { BriefArchiveButton } from "@/components/briefs/BriefArchiveButton";
import { VideoBriefEditDrawer } from "@/components/briefs/VideoBriefEditDrawer";
import { Button } from "@/components/ui/button";
import type { VideoBrief } from "@/lib/video-briefs";

export type VideoBriefDetailActionsProps = {
  brief: VideoBrief;
  /** True when the brief is archived (`deleted_at` set). */
  archived: boolean;
};

/**
 * Header action cluster for the video-brief detail page (E3.2 / #591): an Edit
 * button that opens the delivery+status drawer, and the Archive/Restore control
 * (format="video"). Editing is hidden while archived.
 */
export function VideoBriefDetailActions({ brief, archived }: VideoBriefDetailActionsProps) {
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
      <BriefArchiveButton format="video" briefId={brief.id} archived={archived} />

      {!archived ? (
        <VideoBriefEditDrawer open={editOpen} onOpenChange={setEditOpen} brief={brief} />
      ) : null}
    </div>
  );
}
