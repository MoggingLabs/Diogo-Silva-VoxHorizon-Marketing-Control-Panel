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
import { createCopy, updateCopy } from "@/lib/copy/client";
import type { CopyFormatT } from "@/lib/copy/schemas";

/** UI form schema for a copy variant (create + edit share it). */
const CopyEditorSchema = z.object({
  platform: z.enum(["meta", "google", "tiktok"]),
  variant_index: z.coerce.number().int().min(1, "min 1").max(50, "max 50"),
  headline: z.string().max(2000).optional(),
  body: z.string().max(20000).optional(),
  description: z.string().max(2000).optional(),
  cta: z.string().max(200).optional(),
});
type CopyEditorFormT = z.infer<typeof CopyEditorSchema>;

export type CopyVariantLike = {
  id: string;
  platform: string;
  variant_index: number;
  headline: string | null;
  body: string | null;
  description: string | null;
  cta: string | null;
};

export type CopyEditorDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  format: CopyFormatT;
  creativeId: string;
  /** When set, the drawer edits this variant; otherwise it creates a new one. */
  variant?: CopyVariantLike | null;
  /** Suggested index for a new variant (max existing + 1). */
  nextIndex?: number;
};

/**
 * Create / edit drawer for a standalone copy variant (E3.3 / #592).
 *
 * On create it POSTs `/api/copy`; on edit it PATCHes `/api/copy/:id`. The route
 * re-arms compliance on edit (resets the variant to draft), so the drawer warns
 * the operator when editing an existing variant.
 */
export function CopyEditorDrawer({
  open,
  onOpenChange,
  format,
  creativeId,
  variant,
  nextIndex = 1,
}: CopyEditorDrawerProps) {
  const router = useRouter();
  const isEdit = Boolean(variant);

  const defaults: CopyEditorFormT = {
    platform: (variant?.platform as CopyEditorFormT["platform"]) ?? "meta",
    variant_index: variant?.variant_index ?? nextIndex,
    headline: variant?.headline ?? "",
    body: variant?.body ?? "",
    description: variant?.description ?? "",
    cta: variant?.cta ?? "",
  };

  async function onSubmit(values: CopyEditorFormT) {
    if (isEdit && variant) {
      await updateCopy(variant.id, {
        format,
        platform: values.platform,
        variant_index: values.variant_index,
        headline: values.headline ?? "",
        body: values.body ?? "",
        description: values.description ?? "",
        cta: values.cta ?? "",
      });
    } else {
      await createCopy({
        format,
        creative_id: creativeId,
        platform: values.platform,
        variant_index: values.variant_index,
        headline: values.headline || undefined,
        body: values.body || undefined,
        description: values.description || undefined,
        cta: values.cta || undefined,
      });
    }
  }

  return (
    <CrudDrawer<CopyEditorFormT>
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Edit copy variant" : "New copy variant"}
      description={
        isEdit
          ? "Editing copy re-arms compliance: this variant returns to draft and must be re-approved."
          : "Add a copy variant for this creative."
      }
      schema={CopyEditorSchema}
      defaultValues={defaults}
      onSubmit={onSubmit}
      onSuccess={() => router.refresh()}
      successMessage={isEdit ? "Copy variant updated" : "Copy variant created"}
    >
      <CopyEditorFields />
    </CrudDrawer>
  );
}

function CopyEditorFields() {
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<CopyEditorFormT>();

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="copy-platform">Platform</Label>
          <Controller
            control={control}
            name="platform"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="copy-platform">
                  <SelectValue placeholder="Platform" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">Meta</SelectItem>
                  <SelectItem value="google">Google</SelectItem>
                  <SelectItem value="tiktok">TikTok</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="copy-index">Variant index</Label>
          <Input id="copy-index" inputMode="numeric" {...register("variant_index")} />
          {errors.variant_index ? (
            <p className="text-xs text-destructive">{errors.variant_index.message}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="copy-headline">Headline</Label>
        <Input id="copy-headline" {...register("headline")} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="copy-body">Primary text</Label>
        <Textarea id="copy-body" rows={5} {...register("body")} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="copy-description">Description</Label>
        <Input id="copy-description" {...register("description")} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="copy-cta">CTA</Label>
        <Input id="copy-cta" {...register("cta")} />
      </div>
    </>
  );
}
