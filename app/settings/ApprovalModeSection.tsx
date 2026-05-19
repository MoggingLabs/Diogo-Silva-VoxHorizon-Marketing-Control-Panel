"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useApprovalMode } from "@/hooks/approvals/useApprovalMode";
import {
  ApprovalModeInput,
  TTL_PRESETS,
  formatTtlShort,
  type ApprovalMode,
  type ApprovalModeAuditEntry,
} from "@/lib/approval-mode/types";
import { cn } from "@/lib/utils";

/**
 * Operator-controlled approval mode UI block in /settings.
 *
 * Three radio choices: ASK / AUTO_APPROVE / HALT. AUTO_APPROVE reveals
 * a TTL picker (radio sub-list) that the operator must pick before
 * saving. An optional ``note`` field surfaces in the audit trail.
 *
 * Save:
 *   1. Validate locally against the ``ApprovalModeInput`` schema.
 *   2. PUT ``/api/approval-mode``.
 *   3. Refresh both the singleton state (hook) and the audit list.
 *   4. Reset the form state to the freshly-saved values.
 *
 * Audit list:
 *   - Fetched on mount + after every successful save.
 *   - Shows the last 50 transitions newest-first.
 */
type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

function formatChangedAt(ts: string): string {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return ts;
  return new Date(t).toLocaleString();
}

function modeLabel(mode: string): string {
  switch (mode) {
    case "ASK":
      return "ASK";
    case "AUTO_APPROVE":
      return "AUTO_APPROVE";
    case "HALT":
      return "HALT";
    default:
      return mode;
  }
}

export function ApprovalModeSection() {
  const { state, refresh } = useApprovalMode();

  const [selectedMode, setSelectedMode] = useState<ApprovalMode>("ASK");
  const [selectedTtl, setSelectedTtl] = useState<number>(TTL_PRESETS[0]?.seconds ?? 3600);
  const [note, setNote] = useState<string>("");
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

  // Audit list — fetched lazily; refreshed after every save.
  const [audit, setAudit] = useState<ApprovalModeAuditEntry[] | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  // Sync the form's "selected mode" with the live state on first load.
  // Don't overwrite operator edits once they've toggled the radio.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched || !state) return;
    const m = state.mode;
    if (m === "ASK" || m === "AUTO_APPROVE" || m === "HALT") {
      setSelectedMode(m as ApprovalMode);
    }
  }, [state, touched]);

  const refreshAudit = useCallback(async () => {
    try {
      const res = await fetch("/api/approval-mode/audit?limit=50", {
        cache: "no-store",
      });
      if (!res.ok) {
        setAuditError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { entries: ApprovalModeAuditEntry[] };
      setAudit(body.entries ?? []);
      setAuditError(null);
    } catch (e) {
      setAuditError(e instanceof Error ? e.message : "fetch failed");
    }
  }, []);

  useEffect(() => {
    void refreshAudit();
  }, [refreshAudit]);

  const onSave = useCallback(async () => {
    setStatus({ kind: "saving" });
    const payload: Record<string, unknown> = { mode: selectedMode };
    if (selectedMode === "AUTO_APPROVE") {
      payload.ttl_seconds = selectedTtl;
    }
    if (note.trim()) payload.note = note.trim();

    const parsed = ApprovalModeInput.safeParse(payload);
    if (!parsed.success) {
      setStatus({
        kind: "error",
        message: parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "),
      });
      return;
    }

    try {
      const res = await fetch("/api/approval-mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setStatus({
          kind: "error",
          message: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        });
        return;
      }
      setStatus({ kind: "saved" });
      setNote("");
      setTouched(false);
      await Promise.all([refresh(), refreshAudit()]);
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : "save failed",
      });
    }
  }, [note, refresh, refreshAudit, selectedMode, selectedTtl]);

  const currentLine = useMemo(() => {
    if (!state) return "Loading…";
    const when = state.set_at ? new Date(state.set_at).toLocaleString() : "unknown";
    const who = state.set_by ?? "—";
    if (state.mode === "AUTO_APPROVE") {
      return `Currently: ${modeLabel(state.mode)} (set at ${when} by ${who}; expires in ${formatTtlShort(state.expires_at ?? null)})`;
    }
    return `Currently: ${modeLabel(state.mode)} (set at ${when} by ${who})`;
  }, [state]);

  return (
    <section id="approval-mode" data-testid="approval-mode-section" className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Approval mode</h2>
      <div className="flex flex-col gap-4 rounded-md border bg-background p-4 text-sm">
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Approval mode</legend>

          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="approval-mode"
              value="ASK"
              checked={selectedMode === "ASK"}
              onChange={() => {
                setSelectedMode("ASK");
                setTouched(true);
              }}
              data-testid="mode-radio-ASK"
              className="mt-0.5"
            />
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">ASK</span>
              <span className="text-xs text-muted-foreground">
                Prompt for every sensitive tool (default behaviour).
              </span>
            </div>
          </label>

          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="approval-mode"
              value="AUTO_APPROVE"
              checked={selectedMode === "AUTO_APPROVE"}
              onChange={() => {
                setSelectedMode("AUTO_APPROVE");
                setTouched(true);
              }}
              data-testid="mode-radio-AUTO_APPROVE"
              className="mt-0.5"
            />
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">AUTO_APPROVE</span>
              <span className="text-xs text-muted-foreground">
                Auto-allow sensitive tools without prompting. Picks below.
              </span>
              {selectedMode === "AUTO_APPROVE" ? (
                <div
                  role="radiogroup"
                  aria-label="Auto-approve duration"
                  className="mt-1 flex flex-wrap gap-2"
                >
                  {TTL_PRESETS.map((opt) => (
                    <label
                      key={opt.seconds}
                      className={cn(
                        "inline-flex h-7 cursor-pointer items-center gap-1 rounded-full px-3 text-xs ring-1 transition-colors",
                        selectedTtl === opt.seconds
                          ? "bg-amber-100 text-amber-900 ring-amber-300"
                          : "bg-background text-muted-foreground ring-input hover:bg-accent",
                      )}
                    >
                      <input
                        type="radio"
                        name="auto-approve-ttl"
                        value={opt.seconds}
                        checked={selectedTtl === opt.seconds}
                        onChange={() => setSelectedTtl(opt.seconds)}
                        data-testid={`ttl-radio-${opt.seconds}`}
                        className="sr-only"
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          </label>

          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="approval-mode"
              value="HALT"
              checked={selectedMode === "HALT"}
              onChange={() => {
                setSelectedMode("HALT");
                setTouched(true);
              }}
              data-testid="mode-radio-HALT"
              className="mt-0.5"
            />
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">HALT</span>
              <span className="text-xs text-muted-foreground">
                Block all sensitive tools (no TTL — clear manually).
              </span>
            </div>
          </label>
        </fieldset>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Note (optional)</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            data-testid="mode-note"
            placeholder="e.g. nightly batch run"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>

        <div className="flex items-center justify-between">
          <p data-testid="mode-current-line" className="text-xs text-muted-foreground">
            {currentLine}
          </p>
          <button
            type="button"
            onClick={() => {
              void onSave();
            }}
            disabled={status.kind === "saving"}
            data-testid="mode-save"
            className={cn(
              "inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60",
            )}
          >
            {status.kind === "saving" ? "Saving…" : "Save changes"}
          </button>
        </div>
        {status.kind === "error" ? (
          <p
            role="alert"
            data-testid="mode-save-error"
            className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
          >
            {status.message}
          </p>
        ) : null}
        {status.kind === "saved" ? (
          <p
            data-testid="mode-save-success"
            className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900"
          >
            Mode updated.
          </p>
        ) : null}
      </div>

      <h2 className="mt-4 text-lg font-semibold">Recent mode changes</h2>
      <div
        data-testid="mode-audit"
        className="overflow-hidden rounded-md border bg-background text-sm"
      >
        {auditError ? (
          <p className="px-3 py-2 text-xs text-rose-900">Failed to load audit: {auditError}</p>
        ) : audit === null ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
        ) : audit.length === 0 ? (
          <p
            data-testid="mode-audit-empty"
            className="px-3 py-2 text-xs italic text-muted-foreground"
          >
            No mode changes recorded yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {audit.map((entry) => (
              <li
                key={entry.id}
                data-testid="mode-audit-row"
                className="flex flex-col gap-0.5 px-3 py-2"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-xs">
                    {entry.from_mode} → {entry.to_mode}
                    {entry.ttl_seconds !== null
                      ? ` (${Math.round(entry.ttl_seconds / 3600)}h)`
                      : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatChangedAt(entry.changed_at)} · {entry.changed_by}
                  </span>
                </div>
                {entry.note ? (
                  <span className="text-xs text-muted-foreground">{entry.note}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
