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
import {
  BriefStatus,
  canTransition,
  type Brief,
  type BriefStatusT,
  readBriefPayload,
} from "@/lib/briefs";
import { updateImageBrief } from "@/lib/briefs-client";

/**
 * Image-brief edit form schema (E3.2 / #591).
 *
 * String-typed inputs (numbers coerced) covering the payload fields an operator
 * edits in place, plus the status. The server still re-validates the full
 * `BriefPayload`, so this is the UI-side mirror; the submit handler rebuilds the
 * canonical payload and PATCHes `/api/briefs/:id`.
 */
const BriefEditFormSchema = z.object({
  service: z.enum(["roofing", "remodeling"]),
  market: z.string().min(2, "market is required").max(200),
  budget: z.coerce.number().positive("budget must be > 0").max(100000),
  budget_daily: z.string().optional(),
  landing_page_url: z
    .string()
    .trim()
    .max(2048)
    .optional()
    .refine((v) => !v || /^https?:\/\//.test(v), "must be a URL"),
  offer_text: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
  status: BriefStatus,
});
type BriefEditFormT = z.infer<typeof BriefEditFormSchema>;

export type BriefEditDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brief: Brief;
};

/**
 * Edit drawer for an image brief's payload + status. Status options are limited
 * to the transitions the state machine allows from the current status (plus the
 * current value itself), so the operator can't request an illegal transition;
 * the route still enforces it server-side (409 on violation).
 */
export function BriefEditDrawer({ open, onOpenChange, brief }: BriefEditDrawerProps) {
  const router = useRouter();
  const payload = readBriefPayload(brief);
  const from = brief.status as BriefStatusT;

  const statusOptions = React.useMemo(() => buildStatusOptions(from), [from]);

  const defaults: BriefEditFormT = {
    service: payload?.service ?? "roofing",
    market: payload?.market ?? "",
    budget: payload?.budget ?? 0,
    budget_daily: typeof payload?.budget_daily === "number" ? String(payload.budget_daily) : "",
    landing_page_url: payload?.landing_page_url ?? "",
    offer_text: payload?.offer_text ?? "",
    notes: payload?.notes ?? "",
    status: from,
  };

  async function onSubmit(values: BriefEditFormT) {
    // Rebuild the payload, preserving fields the drawer does not expose
    // (targeting, angles, creative_plan) so an edit never silently drops them.
    const nextPayload: Record<string, unknown> = {
      ...(payload ?? {}),
      service: values.service,
      market: values.market,
      budget: values.budget,
    };
    if (values.budget_daily && values.budget_daily.trim()) {
      nextPayload.budget_daily = Number(values.budget_daily);
    } else {
      delete nextPayload.budget_daily;
    }
    if (values.landing_page_url && values.landing_page_url.trim()) {
      nextPayload.landing_page_url = values.landing_page_url.trim();
    } else {
      delete nextPayload.landing_page_url;
    }
    if (values.offer_text && values.offer_text.trim()) nextPayload.offer_text = values.offer_text;
    else delete nextPayload.offer_text;
    if (values.notes && values.notes.trim()) nextPayload.notes = values.notes;
    else delete nextPayload.notes;

    const body: { payload?: Record<string, unknown>; status?: string } = { payload: nextPayload };
    if (values.status !== from) body.status = values.status;

    await updateImageBrief(brief.id, body);
  }

  return (
    <CrudDrawer<BriefEditFormT>
      open={open}
      onOpenChange={onOpenChange}
      title="Edit brief"
      description="Update the brief payload and status."
      schema={BriefEditFormSchema}
      defaultValues={defaults}
      onSubmit={onSubmit}
      onSuccess={() => router.refresh()}
      successMessage="Brief updated"
    >
      <BriefEditFields statusOptions={statusOptions} />
    </CrudDrawer>
  );
}

function BriefEditFields({
  statusOptions,
}: {
  statusOptions: { value: BriefStatusT; label: string }[];
}) {
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<BriefEditFormT>();

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="edit-service">Service</Label>
        <Controller
          control={control}
          name="service"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="edit-service">
                <SelectValue placeholder="Service" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="roofing">Roofing</SelectItem>
                <SelectItem value="remodeling">Remodeling</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="edit-market">Market</Label>
        <Input id="edit-market" {...register("market")} placeholder="Austin, TX" />
        {errors.market ? <p className="text-xs text-destructive">{errors.market.message}</p> : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="edit-budget">Total budget ($)</Label>
          <Input id="edit-budget" inputMode="numeric" {...register("budget")} />
          {errors.budget ? (
            <p className="text-xs text-destructive">{errors.budget.message}</p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="edit-budget-daily">Daily budget ($)</Label>
          <Input id="edit-budget-daily" inputMode="numeric" {...register("budget_daily")} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="edit-lp">Landing page URL</Label>
        <Input
          id="edit-lp"
          {...register("landing_page_url")}
          placeholder="https://example.com/lp"
        />
        {errors.landing_page_url ? (
          <p className="text-xs text-destructive">{errors.landing_page_url.message}</p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="edit-offer">Offer text</Label>
        <Input id="edit-offer" {...register("offer_text")} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="edit-notes">Notes</Label>
        <Textarea id="edit-notes" rows={4} {...register("notes")} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="edit-status">Status</Label>
        <Controller
          control={control}
          name="status"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="edit-status">
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

const STATUS_LABEL: Record<BriefStatusT, string> = {
  draft: "Draft",
  posted: "Posted",
  approved: "Approved",
  approved_with_changes: "Approved with changes",
  rejected: "Rejected",
};

/**
 * The status options for the edit drawer: the current status plus every status
 * it can legally transition to. Decisions (approved / rejected) are normally
 * made via the approval gate with notes, but the state machine permits them, so
 * they appear here as well — the route enforces the same rules.
 */
function buildStatusOptions(from: BriefStatusT): { value: BriefStatusT; label: string }[] {
  const all: BriefStatusT[] = ["draft", "posted", "approved", "approved_with_changes", "rejected"];
  return all
    .filter((s) => s === from || canTransition(from, s))
    .map((s) => ({ value: s, label: STATUS_LABEL[s] }));
}
