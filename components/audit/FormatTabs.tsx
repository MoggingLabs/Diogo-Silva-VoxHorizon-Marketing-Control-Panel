"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";

import { AUDIT_FORMAT_VALUES, type AuditFormat } from "@/lib/audit";
import { cn } from "@/lib/utils";

const OPTION_LABELS: Record<AuditFormat, string> = {
  combined: "All formats",
  image: "Image",
  video: "Video",
};

export type FormatTabsProps = {
  value: AuditFormat;
};

/**
 * URL-driven format tabs for the audit page. Same pattern as the dashboard's
 * `<FormatToggle />` but tuned for the audit context: the default option is
 * `combined` (not `both`) so the URL stays clean when no filter is active.
 *
 * Hardcoded `/audit` pathname keeps Next.js typed-routes happy.
 */
export function FormatTabs({ value }: FormatTabsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function select(next: AuditFormat) {
    if (next === value) return;
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "combined") {
      params.delete("format");
    } else {
      params.set("format", next);
    }
    const qs = params.toString();
    const href = (qs.length > 0 ? `/audit?${qs}` : "/audit") as Route;
    startTransition(() => {
      router.replace(href, { scroll: false });
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Audit format"
      className={cn(
        "inline-flex items-center rounded-md border border-border bg-card p-1 text-sm shadow-sm",
        isPending ? "opacity-80" : null,
      )}
    >
      {AUDIT_FORMAT_VALUES.map((opt) => {
        const selected = opt === value;
        return (
          <button
            key={opt}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => select(opt)}
            className={cn(
              "min-h-[36px] rounded px-3 py-1.5 transition-colors sm:py-1",
              selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {OPTION_LABELS[opt]}
          </button>
        );
      })}
    </div>
  );
}
