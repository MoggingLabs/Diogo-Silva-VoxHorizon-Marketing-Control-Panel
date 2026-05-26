"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useFormContext } from "react-hook-form";
import { z } from "zod";

import { CrudDrawer } from "@/components/shared/CrudDrawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { updateVideoBrief } from "@/lib/briefs-client";
import {
  canTransition,
  VideoBriefStatus,
  type VideoBrief,
  type VideoBriefStatusT,
} from "@/lib/video-briefs";

/**
 * Video-brief edit form schema (E3.2 / #591).
 *
 * Covers the scalar style + delivery fields plus status. The script outline
 * (hook + segment tree, with the duration-sum invariant) is edited via the
 * dedicated form, not this drawer — keeping the drawer focused and avoiding a
 * partial-outline PATCH that would trip the route's duration refinement.
 */
const HOOK_STYLES = ["curiosity", "pattern_interrupt", "data_shock", "question"] as const;
const CAPTIONS_STYLES = ["bold_yellow", "minimal_white", "brand"] as const;
const BROLL_MODES = ["auto", "review_each", "review_low_confidence"] as const;
const RATIOS = ["1x1", "9x16", "16x9"] as const;

const NONE = "__none__";

const VideoBriefEditFormSchema = z.object({
  voice_id: z.string().min(2, "voice_id is required").max(200),
  music_track: z.string().max(200).optional(),
  dimensions: z.enum(RATIOS),
  hook_style: z.string().optional(),
  captions_style: z.string().optional(),
  broll_selection_mode: z.enum(BROLL_MODES),
  notes: z.string().max(5000).optional(),
  status: VideoBriefStatus,
});
type VideoBriefEditFormT = z.infer<typeof VideoBriefEditFormSchema>;

export type VideoBriefEditDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brief: VideoBrief;
};

export function VideoBriefEditDrawer({ open, onOpenChange, brief }: VideoBriefEditDrawerProps) {
  const router = useRouter();
  const from = brief.status as VideoBriefStatusT;
  const statusOptions = React.useMemo(() => buildStatusOptions(from), [from]);

  const existingNotes =
    typeof brief.payload === "object" && brief.payload !== null && !Array.isArray(brief.payload)
      ? ((brief.payload as Record<string, unknown>).notes as string | undefined)
      : undefined;

  const defaults: VideoBriefEditFormT = {
    voice_id: brief.voice_id ?? "",
    music_track: brief.music_track ?? "",
    dimensions: (brief.dimensions as (typeof RATIOS)[number] | null) ?? "9x16",
    hook_style: brief.hook_style ?? NONE,
    captions_style: brief.captions_style ?? NONE,
    broll_selection_mode:
      (brief.broll_selection_mode as (typeof BROLL_MODES)[number]) ?? "review_each",
    notes: existingNotes ?? "",
    status: from,
  };

  async function onSubmit(values: VideoBriefEditFormT) {
    const body: Record<string, unknown> = {
      voice_id: values.voice_id,
      music_track: values.music_track?.trim() ? values.music_track.trim() : null,
      dimensions: values.dimensions,
      hook_style: values.hook_style && values.hook_style !== NONE ? values.hook_style : null,
      captions_style:
        values.captions_style && values.captions_style !== NONE ? values.captions_style : null,
      broll_selection_mode: values.broll_selection_mode,
      notes: values.notes ?? "",
    };
    if (values.status !== from) body.status = values.status;
    await updateVideoBrief(brief.id, body);
  }

  return (
    <CrudDrawer<VideoBriefEditFormT>
      open={open}
      onOpenChange={onOpenChange}
      title="Edit video brief"
      description="Update delivery + style settings and status. Edit the script outline from the dedicated form."
      schema={VideoBriefEditFormSchema}
      defaultValues={defaults}
      onSubmit={onSubmit}
      onSuccess={() => router.refresh()}
      successMessage="Video brief updated"
    >
      <VideoBriefEditFields statusOptions={statusOptions} />
    </CrudDrawer>
  );
}

function VideoBriefEditFields({
  statusOptions,
}: {
  statusOptions: { value: VideoBriefStatusT; label: string }[];
}) {
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<VideoBriefEditFormT>();

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="vedit-voice">Voice ID</Label>
        <Input id="vedit-voice" {...register("voice_id")} placeholder="21m00Tcm4TlvDq8ikWAM" />
        {errors.voice_id ? (
          <p className="text-xs text-destructive">{errors.voice_id.message}</p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vedit-music">Music track</Label>
        <Input id="vedit-music" {...register("music_track")} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="vedit-dims">Dimensions</Label>
          <Controller
            control={control}
            name="dimensions"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="vedit-dims">
                  <SelectValue placeholder="Dimensions" />
                </SelectTrigger>
                <SelectContent>
                  {RATIOS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="vedit-broll">B-roll selection</Label>
          <Controller
            control={control}
            name="broll_selection_mode"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="vedit-broll">
                  <SelectValue placeholder="B-roll mode" />
                </SelectTrigger>
                <SelectContent>
                  {BROLL_MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="vedit-hook">Hook style</Label>
          <Controller
            control={control}
            name="hook_style"
            render={({ field }) => (
              <Select value={field.value || NONE} onValueChange={field.onChange}>
                <SelectTrigger id="vedit-hook">
                  <SelectValue placeholder="Hook style" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {HOOK_STYLES.map((h) => (
                    <SelectItem key={h} value={h}>
                      {h.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="vedit-captions">Captions style</Label>
          <Controller
            control={control}
            name="captions_style"
            render={({ field }) => (
              <Select value={field.value || NONE} onValueChange={field.onChange}>
                <SelectTrigger id="vedit-captions">
                  <SelectValue placeholder="Captions style" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {CAPTIONS_STYLES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vedit-notes">Notes</Label>
        <Textarea id="vedit-notes" rows={4} {...register("notes")} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vedit-status">Status</Label>
        <Controller
          control={control}
          name="status"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="vedit-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>
    </>
  );
}

const STATUS_LABEL: Record<VideoBriefStatusT, string> = {
  draft: "Draft",
  posted: "Posted",
  approved: "Approved",
  approved_with_changes: "Approved with changes",
  rejected: "Rejected",
};

function buildStatusOptions(
  from: VideoBriefStatusT,
): { value: VideoBriefStatusT; label: string }[] {
  const all: VideoBriefStatusT[] = [
    "draft",
    "posted",
    "approved",
    "approved_with_changes",
    "rejected",
  ];
  return all
    .filter((s) => s === from || canTransition(from, s))
    .map((s) => ({ value: s, label: STATUS_LABEL[s] }));
}
