"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, ShieldAlert, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Textarea } from "@/components/ui/textarea";
import {
  overrideCompliance,
  overrideSpec,
  rerunQa,
  type CreativeKind,
} from "@/lib/creatives-client";

type Row = Record<string, unknown> & { id: string };

export type ManagedGatePanelsProps = {
  creativeId: string;
  pipelineId: string | null;
  surface: CreativeKind;
  qa: Row[];
  spec: Row[];
  compliance: Row[];
};

const SPEC_STATUSES = ["pending", "pass", "warn", "fail", "exception"] as const;

/**
 * The managed surfaces for a creative's PROTECTED gate artifacts (M6).
 *
 * Instead of sending the operator off to the pipeline review, this panel
 * exposes the CORRECT action for each protected table inline — never a raw
 * edit/delete:
 *
 *   - QA (`qa_result`, APPEND-ONLY): shows the attempt history and a "Re-run QA"
 *     action that POSTs to the worker QA route, which appends a NEW attempt.
 *     There is no edit/delete of a prior attempt.
 *   - Spec (`spec_check`, OVERRIDE-ROUTE only): shows each placement and an
 *     Override action that submits a corrected per-placement result (+ required
 *     reason) through the worker spec upsert + the DB rollup.
 *   - Compliance (`compliance_finding`, OVERRIDE-ROUTE only): shows the findings
 *     and an Override action (+ required justification) that calls the existing
 *     pipeline compliance-override route; the failing findings are retained.
 *
 * Self-contained + presentational: the parent resolves the rows server-side and
 * passes them down, so this is testable without a live Supabase. Each action
 * `router.refresh()`es on success so the freshly-appended/overridden state
 * shows.
 */
export function ManagedGatePanels({
  creativeId,
  pipelineId,
  surface,
  qa,
  spec,
  compliance,
}: ManagedGatePanelsProps) {
  return (
    <div className="space-y-4">
      <QaPanel creativeId={creativeId} pipelineId={pipelineId} surface={surface} qa={qa} />
      <SpecPanel creativeId={creativeId} pipelineId={pipelineId} spec={spec} />
      <CompliancePanel creativeId={creativeId} pipelineId={pipelineId} compliance={compliance} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// QA — append-only re-run
// ---------------------------------------------------------------------------

function QaPanel({
  creativeId,
  pipelineId,
  surface,
  qa,
}: {
  creativeId: string;
  pipelineId: string | null;
  surface: CreativeKind;
  qa: Row[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  // Newest attempt first for the "latest verdict" line.
  const sorted = [...qa].sort((a, b) => attemptOf(b) - attemptOf(a));

  async function onRerun() {
    // The button is disabled when pipelineId is null, so the missing-pipeline
    // path is gated upstream — no in-handler guard needed.
    setBusy(true);
    try {
      const out = await rerunQa(creativeId, { surface });
      const first = out.results[0];
      if (first) {
        toast.success(`QA re-run: attempt ${first.attempt} -> ${first.verdict}`);
      } else if (out.errors[0]) {
        toast.error(`QA re-run failed: ${out.errors[0].error}`);
      } else {
        toast.success("QA re-run submitted");
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "QA re-run failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <GatePanel
      label="QA"
      hint="Append-only: a re-run posts a new attempt; prior attempts are never edited."
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={busy || !pipelineId}
          onClick={() => void onRerun()}
          data-testid="qa-rerun"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Re-run QA
        </Button>
      }
    >
      {sorted.length === 0 ? (
        <Empty>No QA attempts yet. Re-run QA to record the first attempt.</Empty>
      ) : (
        <ul className="space-y-1" data-testid="qa-attempts">
          {sorted.map((r) => (
            <GateRow
              key={r.id}
              primary={`Attempt ${String(r.attempt ?? "?")}`}
              status={String(r.status ?? "unknown")}
              note={defectsLabel(r.defects)}
            />
          ))}
        </ul>
      )}
    </GatePanel>
  );
}

function attemptOf(r: Row): number {
  const a = r.attempt;
  return typeof a === "number" ? a : Number(a ?? 0);
}

function defectsLabel(defects: unknown): string | undefined {
  if (Array.isArray(defects) && defects.length > 0) {
    return `${defects.length} defect(s)`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Spec — override-route only
// ---------------------------------------------------------------------------

function SpecPanel({
  creativeId,
  pipelineId,
  spec,
}: {
  creativeId: string;
  pipelineId: string | null;
  spec: Row[];
}) {
  const router = useRouter();
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<(typeof SPEC_STATUSES)[number]>("pass");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const canSubmit = reason.trim().length > 0 && !busy && pipelineId != null;

  function openOverride(rowId: string) {
    setOpenId(rowId);
    setStatus("pass");
    setReason("");
  }

  async function submit(row: Row) {
    // `canSubmit` already gates on `pipelineId != null` + a non-empty reason;
    // the submit button is disabled otherwise (no in-handler guard needed).
    setBusy(true);
    try {
      await overrideSpec(creativeId, {
        platform: (typeof row.platform === "string" ? row.platform : "meta") as
          | "meta"
          | "google"
          | "tiktok",
        placement: String(row.placement ?? ""),
        status,
        reason: reason.trim(),
        ...(typeof row.ratio === "string" && row.ratio ? { ratio: row.ratio } : {}),
      });
      toast.success("Spec override submitted");
      setOpenId(null);
      setReason("");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Spec override failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <GatePanel
      label="Spec"
      hint="Override-route only: a corrected placement result goes through the worker + rollup, never a raw edit."
    >
      {spec.length === 0 ? (
        <Empty>No spec checks recorded.</Empty>
      ) : (
        <ul className="space-y-1" data-testid="spec-rows">
          {spec.map((r) => (
            <li key={r.id} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 rounded-md border bg-card px-2 py-1 text-xs">
                <span className="truncate">
                  {String(r.platform ?? "—")} · {String(r.placement ?? "—")}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <StatusBadge status={String(r.status ?? "unknown")} />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 px-1.5 text-[11px]"
                    onClick={() => openOverride(r.id)}
                    disabled={!pipelineId}
                    data-testid={`spec-override-open-${r.id}`}
                  >
                    <SlidersHorizontal className="h-3 w-3" aria-hidden="true" />
                    Override
                  </Button>
                </span>
              </div>
              {openId === r.id ? (
                <div
                  className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/20"
                  data-testid="spec-override-form"
                >
                  <div className="space-y-1">
                    <Label htmlFor={`spec-status-${r.id}`} className="text-[11px]">
                      Corrected status
                    </Label>
                    <Select
                      value={status}
                      onValueChange={(v) => setStatus(v as (typeof SPEC_STATUSES)[number])}
                    >
                      <SelectTrigger id={`spec-status-${r.id}`} className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SPEC_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`spec-reason-${r.id}`} className="text-[11px]">
                      Reason (required)
                    </Label>
                    <Textarea
                      id={`spec-reason-${r.id}`}
                      rows={2}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Why is this placement correction acceptable?"
                      data-testid="spec-override-reason"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={!canSubmit}
                      onClick={() => void submit(r)}
                      data-testid="spec-override-submit"
                    >
                      {busy ? "Submitting…" : "Submit override"}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setOpenId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </GatePanel>
  );
}

// ---------------------------------------------------------------------------
// Compliance — override-route only (existing pipeline route)
// ---------------------------------------------------------------------------

function CompliancePanel({
  creativeId,
  pipelineId,
  compliance,
}: {
  creativeId: string;
  pipelineId: string | null;
  compliance: Row[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const failing = compliance.filter(
    (r) => String(r.verdict ?? "") === "fail" && r.overridden !== true,
  );
  const canSubmit = note.trim().length > 0 && !busy && pipelineId != null;

  async function submit() {
    // `canSubmit` already gates on `pipelineId != null` + a non-empty note.
    setBusy(true);
    try {
      // Non-null assertion: `canSubmit` requires `pipelineId != null`.
      await overrideCompliance(pipelineId as string, {
        creative_id: creativeId,
        override_note: note.trim(),
      });
      toast.success("Compliance override recorded");
      setOpen(false);
      setNote("");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Compliance override failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <GatePanel
      label="Compliance"
      hint="Override-route only: releasing a hard block requires a written justification; the failing findings are kept."
      action={
        failing.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => {
              setOpen(true);
              setNote("");
            }}
            disabled={!pipelineId}
            data-testid="compliance-override-open"
          >
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
            Override block
          </Button>
        ) : undefined
      }
    >
      {compliance.length === 0 ? (
        <Empty>No compliance findings.</Empty>
      ) : (
        <ul className="space-y-1" data-testid="compliance-rows">
          {compliance.map((r) => (
            <GateRow
              key={r.id}
              primary={String(r.rule_id ?? "—")}
              status={String(r.verdict ?? "unknown")}
              note={r.overridden === true ? "overridden" : undefined}
            />
          ))}
        </ul>
      )}
      {open ? (
        <div
          className="mt-2 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/20"
          data-testid="compliance-override-form"
        >
          <Label htmlFor="compliance-note" className="text-[11px]">
            Justification (required)
          </Label>
          <Textarea
            id="compliance-note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why is releasing this compliance block acceptable?"
            data-testid="compliance-override-note"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={!canSubmit}
              onClick={() => void submit()}
              data-testid="compliance-override-submit"
            >
              {busy ? "Overriding…" : "Confirm override"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </GatePanel>
  );
}

// ---------------------------------------------------------------------------
// Shared presentational bits
// ---------------------------------------------------------------------------

function GatePanel({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-foreground">{label}</p>
        {action ?? null}
      </div>
      <div className="space-y-1">{children}</div>
      <p className="text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function GateRow({ status, primary, note }: { status: string; primary: string; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-card px-2 py-1 text-xs">
      <span className="truncate">{primary}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {note ? <span className="text-[10px] text-amber-600">{note}</span> : null}
        <StatusBadge status={status} />
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}
