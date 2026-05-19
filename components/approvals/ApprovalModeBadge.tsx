"use client";

import Link from "next/link";
import type { Route } from "next";

import { useApprovalMode } from "@/hooks/approvals/useApprovalMode";
import { formatTtlShort } from "@/lib/approval-mode/types";
import { cn } from "@/lib/utils";

/**
 * Small pill rendered in the header next to ``<ApprovalQueue />`` when the
 * operator-controlled mode is anything other than ``ASK``:
 *
 *   - ``AUTO_APPROVE`` → yellow pill ``Auto HH:MMm`` (remaining TTL)
 *   - ``HALT``         → red pill ``Halted``
 *
 * Clicking the pill navigates to ``/settings#approval-mode`` so the
 * operator can flip back to ASK without hunting through the menu.
 *
 * Hidden entirely when the mode is ASK (the default) — no chrome means
 * the badge is unobtrusive when nothing's off-default.
 */
export function ApprovalModeBadge() {
  const { state, loading } = useApprovalMode();

  if (loading || !state) return null;
  // Cast through string so we can compare even when the type widens to
  // ``string`` (the row's ``mode`` column is text, not a Postgres enum).
  const mode = state.mode;
  if (mode === "ASK") return null;

  if (mode === "HALT") {
    return (
      <Link
        href={"/settings" as Route}
        data-testid="approval-mode-badge"
        data-mode="HALT"
        aria-label="Approvals halted — click to re-enable"
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11px] font-semibold transition-colors",
          "bg-rose-100 text-rose-900 ring-1 ring-rose-300 hover:bg-rose-200",
        )}
      >
        <span aria-hidden="true">●</span>
        <span>Halted</span>
      </Link>
    );
  }

  if (mode === "AUTO_APPROVE") {
    const ttl = formatTtlShort(state.expires_at ?? null);
    return (
      <Link
        href={"/settings" as Route}
        data-testid="approval-mode-badge"
        data-mode="AUTO_APPROVE"
        aria-label={`Auto-approve mode active, ${ttl} remaining — click to change`}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11px] font-semibold transition-colors",
          "bg-amber-100 text-amber-900 ring-1 ring-amber-300 hover:bg-amber-200",
        )}
      >
        <span aria-hidden="true">⏱</span>
        <span>Auto {ttl}</span>
      </Link>
    );
  }

  // Unknown mode (defensive — schema CHECK constraint forbids it).
  return null;
}
