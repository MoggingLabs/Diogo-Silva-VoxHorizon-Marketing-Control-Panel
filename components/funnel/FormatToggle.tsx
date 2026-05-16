"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { FORMAT_VALUES, type DashboardFormat } from "@/lib/dashboard-types";
import { cn } from "@/lib/utils";

const OPTION_LABELS: Record<DashboardFormat, string> = {
  image: "Image",
  video: "Video",
  both: "Both",
};

export type FormatToggleProps = {
  value: DashboardFormat;
};

/**
 * URL-driven format selector. We persist the choice in the `?format=` search
 * param (not localStorage) so the view is shareable and survives a hard reload.
 * Picking an option calls `router.replace(...)` so the back button doesn't get
 * polluted with every toggle.
 *
 * The dashboard lives at `/`, so we always navigate to root + the encoded
 * search params. Hardcoding the pathname here also keeps `typedRoutes` happy.
 */
export function FormatToggle({ value }: FormatToggleProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function select(next: DashboardFormat) {
    if (next === value) return;
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "both") {
      params.delete("format");
    } else {
      params.set("format", next);
    }
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs.length > 0 ? `/?${qs}` : "/", { scroll: false });
    });
  }

  return (
    <div
      role="radiogroup"
      aria-label="Dashboard format"
      className={cn(
        "inline-flex items-center rounded-md border border-border bg-card p-1 text-sm shadow-sm",
        isPending ? "opacity-80" : null,
      )}
    >
      {FORMAT_VALUES.map((opt) => {
        const selected = opt === value;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => select(opt)}
            className={cn(
              "rounded px-3 py-1 transition-colors",
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
