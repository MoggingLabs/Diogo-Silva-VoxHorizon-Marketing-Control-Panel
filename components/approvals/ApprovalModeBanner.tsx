"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

import { useApprovalMode } from "@/hooks/approvals/useApprovalMode";
import { formatTtlShort } from "@/lib/approval-mode/types";
import { cn } from "@/lib/utils";

const SESSION_DISMISS_KEY = "approval-mode-banner-dismissed";

/**
 * Banner rendered at the very top of ``/approvals`` when the operator-
 * controlled mode is anything other than ``ASK``:
 *
 *   - ``AUTO_APPROVE`` → yellow banner explaining auto-approve is on
 *   - ``HALT``         → red banner explaining approvals are halted
 *
 * Operator can click ``X`` to dismiss for the current session (the dismiss
 * state lives in ``sessionStorage`` so it returns on the next session as
 * long as the mode is still non-ASK).
 */
export function ApprovalModeBanner() {
  const { state, loading } = useApprovalMode();
  const [dismissed, setDismissed] = useState(false);

  // Initialize the dismissed state from sessionStorage on mount. We do
  // this in an effect so SSR + the first client render agree on the
  // initial state (``false`` everywhere), avoiding hydration warnings.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setDismissed(window.sessionStorage.getItem(SESSION_DISMISS_KEY) === "1");
    } catch {
      // sessionStorage can throw in private-browsing modes; ignore.
    }
  }, []);

  if (loading || !state || dismissed) return null;
  const mode = state.mode;
  if (mode === "ASK") return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(SESSION_DISMISS_KEY, "1");
    } catch {
      // ignore
    }
  };

  if (mode === "AUTO_APPROVE") {
    const ttl = formatTtlShort(state.expires_at ?? null);
    const until = state.expires_at ? new Date(state.expires_at).toLocaleString() : "unknown";
    return (
      <div
        role="alert"
        data-testid="approval-mode-banner"
        data-mode="AUTO_APPROVE"
        className={cn(
          "flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm",
          "border-amber-300 bg-amber-50 text-amber-900",
        )}
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <p className="font-medium">
              Auto-approve mode active until {until} ({ttl} remaining).
            </p>
            <p className="text-xs">
              Every sensitive tool is being allowed without your review.{" "}
              <Link
                href={"/settings" as Route}
                className="underline underline-offset-2 hover:text-amber-950"
              >
                Change in Settings
              </Link>
              .
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss banner for this session"
          className="rounded-md p-1 text-amber-900 hover:bg-amber-100"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    );
  }

  if (mode === "HALT") {
    return (
      <div
        role="alert"
        data-testid="approval-mode-banner"
        data-mode="HALT"
        className={cn(
          "flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm",
          "border-rose-300 bg-rose-50 text-rose-900",
        )}
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <p className="font-medium">Approvals are halted.</p>
            <p className="text-xs">
              Ekko cannot run any sensitive tools right now.{" "}
              <Link
                href={"/settings" as Route}
                className="underline underline-offset-2 hover:text-rose-950"
              >
                Re-enable in Settings
              </Link>
              .
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss banner for this session"
          className="rounded-md p-1 text-rose-900 hover:bg-rose-100"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return null;
}
