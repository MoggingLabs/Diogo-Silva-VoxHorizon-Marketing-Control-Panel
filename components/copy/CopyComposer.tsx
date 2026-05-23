"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Sparkles, X } from "lucide-react";

import { CharCounter } from "@/components/copy/CharCounter";
import { Button } from "@/components/ui/button";
import {
  countWithStatus,
  type CopyField,
  type CopyPlatform,
  type CopyPlacement,
} from "@/lib/copy/platform-limits";
import { cn } from "@/lib/utils";

/**
 * CopyComposer (#359, P4.4): author / edit / approve ≥3 copy variants per
 * creative. First in-pipeline copy authoring; `copy_variants` is wired here.
 *
 * Per variant the manager edits headline / primary text / description, sees a
 * live `CharCounter` against the destination platform's limits, can toggle the
 * "humanized" flag, and approves / rejects. The ≥3-approved gate is surfaced
 * inline: the composer shows the approved count and disables nothing itself —
 * the launch gate enforces the precondition — but it nudges the manager toward
 * 3 approvals per creative.
 *
 * Networking is delegated to `/api/pipelines/[id]/copy` (upsert) and
 * `/api/pipelines/[id]/copy/decision` (approve/reject). Editing an approved
 * variant re-arms compliance (the server resets it to draft on edit).
 */
export type CopyVariantView = {
  id: string;
  creative_id: string;
  platform: CopyPlatform | "tiktok";
  placement: CopyPlacement | null;
  variant_index: number;
  headline: string | null;
  body: string | null;
  description: string | null;
  cta: string | null;
  humanized: boolean | null;
  status: string | null;
};

export type CopyComposerProps = {
  pipelineId: string;
  creativeId: string;
  /** Display name for the creative this copy belongs to. */
  creativeLabel: string;
  variants: CopyVariantView[];
  /** Winning-copy registry suggestions (headline patterns). */
  suggestions?: string[];
  /** Minimum approved variants required before launch (display only). */
  minApproved?: number;
};

const MIN_APPROVED_DEFAULT = 3;

export function CopyComposer({
  pipelineId,
  creativeId,
  creativeLabel,
  variants,
  suggestions = [],
  minApproved = MIN_APPROVED_DEFAULT,
}: CopyComposerProps) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const approvedCount = useMemo(
    () => variants.filter((v) => v.status === "approved").length,
    [variants],
  );

  const nextIndex = useMemo(
    () => (variants.length === 0 ? 1 : Math.max(...variants.map((v) => v.variant_index)) + 1),
    [variants],
  );

  const decide = async (id: string, decision: "approved" | "rejected") => {
    if (decision === "rejected") {
      const notes = typeof window !== "undefined" ? window.prompt("Reason for rejecting?") : "n/a";
      if (!notes || !notes.trim()) return;
      await post(id, decision, notes);
      return;
    }
    await post(id, decision);
  };

  const post = async (id: string, decision: "approved" | "rejected", notes?: string) => {
    setError(null);
    setBusyId(id);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/copy/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision, notes }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Request failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusyId(null);
    }
  };

  const addVariant = () => {
    // The editor saves on blur via CopyVariantEditor's onSave; "Add" seeds an
    // empty draft row through the upsert route, then refreshes.
    void saveVariant({
      creative_id: creativeId,
      platform: "meta",
      variant_index: nextIndex,
      headline: "",
      body: "",
    });
  };

  const saveVariant = async (payload: Record<string, unknown>) => {
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Save failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    }
  };

  const enough = approvedCount >= minApproved;

  return (
    <section className="space-y-4" data-testid="copy-composer" data-creative={creativeId}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Copy for {creativeLabel}</h3>
        <span
          data-testid="approved-count"
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
            enough
              ? "bg-emerald-100 text-emerald-900 ring-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-800"
              : "bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-800",
          )}
        >
          {approvedCount} / {minApproved} approved
        </span>
      </header>

      {suggestions.length > 0 ? (
        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
          <p className="mb-1 flex items-center gap-1 font-medium text-foreground">
            <Sparkles aria-hidden="true" className="size-3.5" />
            Winning-copy suggestions
          </p>
          <ul className="flex flex-wrap gap-2" data-testid="copy-suggestions">
            {suggestions.map((s, i) => (
              <li
                key={i}
                className="rounded-full bg-background px-2 py-0.5 text-muted-foreground ring-1 ring-inset ring-border"
              >
                {s}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      ) : null}

      <ul className="space-y-3">
        {variants.map((v) => (
          <li key={v.id}>
            <CopyVariantEditor
              variant={v}
              busy={busyId === v.id}
              onSave={(patch) => saveVariant({ id: v.id, creative_id: v.creative_id, ...patch })}
              onApprove={() => decide(v.id, "approved")}
              onReject={() => decide(v.id, "rejected")}
            />
          </li>
        ))}
      </ul>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={addVariant}
        data-testid="add-variant"
      >
        Add variant
      </Button>
    </section>
  );
}

type EditorPatch = {
  platform?: CopyPlatform | "tiktok";
  placement?: CopyPlacement | null;
  variant_index?: number;
  headline?: string;
  body?: string;
  description?: string;
  cta?: string;
  humanized?: boolean;
};

function CopyVariantEditor({
  variant,
  busy,
  onSave,
  onApprove,
  onReject,
}: {
  variant: CopyVariantView;
  busy: boolean;
  onSave: (patch: EditorPatch) => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [headline, setHeadline] = useState(variant.headline ?? "");
  const [body, setBody] = useState(variant.body ?? "");
  const [description, setDescription] = useState(variant.description ?? "");
  const [humanized, setHumanized] = useState(variant.humanized ?? false);

  // Char limits are published for meta/google only; tiktok counts unbounded.
  const platform: CopyPlatform = variant.platform === "google" ? "google" : "meta";
  const placement = (variant.placement ?? undefined) as CopyPlacement | undefined;

  const overLimit = (field: CopyField, value: string) =>
    countWithStatus(value, field, platform, placement).status === "error";
  const anyOver =
    overLimit("headline", headline) ||
    overLimit("primary_text", body) ||
    overLimit("description", description);

  const isApproved = variant.status === "approved";
  const isRejected = variant.status === "rejected";

  const save = () =>
    onSave({
      platform: variant.platform,
      placement: variant.placement,
      variant_index: variant.variant_index,
      headline,
      body,
      description,
      humanized,
    });

  return (
    <div
      data-testid={`variant-${variant.id}`}
      data-status={variant.status ?? "draft"}
      className={cn(
        "space-y-2 rounded-md border p-3",
        isApproved ? "border-emerald-300 bg-emerald-50/40 dark:bg-emerald-950/10" : "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">
          Variant {variant.variant_index} · {variant.platform}
        </span>
        <span className="capitalize text-muted-foreground">{variant.status ?? "draft"}</span>
      </div>

      <label className="block text-xs font-medium">Headline</label>
      <input
        data-testid={`headline-${variant.id}`}
        value={headline}
        onChange={(e) => setHeadline(e.target.value)}
        onBlur={save}
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
      />
      <CharCounter value={headline} field="headline" platform={platform} placement={placement} />

      <label className="block text-xs font-medium">Primary text</label>
      <textarea
        data-testid={`body-${variant.id}`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onBlur={save}
        className="min-h-[64px] w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
      />
      <CharCounter value={body} field="primary_text" platform={platform} placement={placement} />

      <label className="block text-xs font-medium">Description</label>
      <input
        data-testid={`description-${variant.id}`}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={save}
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
      />
      <CharCounter
        value={description}
        field="description"
        platform={platform}
        placement={placement}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            data-testid={`humanize-${variant.id}`}
            checked={humanized}
            onChange={(e) => {
              setHumanized(e.target.checked);
            }}
          />
          Humanized
        </label>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || isApproved || anyOver}
            data-testid={`approve-${variant.id}`}
            onClick={onApprove}
            className="text-emerald-700"
          >
            <Check aria-hidden="true" className="size-3.5" />
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || isRejected}
            data-testid={`reject-${variant.id}`}
            onClick={onReject}
          >
            <X aria-hidden="true" className="size-3.5" />
            Reject
          </Button>
        </div>
      </div>
      {anyOver ? (
        <p className="text-xs text-rose-600" data-testid={`over-limit-${variant.id}`}>
          A field is over its platform limit — trim it before approving.
        </p>
      ) : null}
    </div>
  );
}
