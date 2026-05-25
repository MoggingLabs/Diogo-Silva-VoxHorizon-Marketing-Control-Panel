"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { ChevronRight, Home } from "lucide-react";

import { cn } from "@/lib/utils";

export type Crumb = {
  label: string;
  href?: string;
};

/**
 * Human-readable labels for the known top-level segments. Segments not listed
 * here fall back to a title-cased version of the raw slug (and ids/UUID-ish
 * segments are shown verbatim).
 */
const SEGMENT_LABELS: Record<string, string> = {
  pipeline: "Pipeline",
  operator: "Operator Console",
  clients: "Clients",
  briefs: "Briefs",
  creatives: "Creatives",
  launches: "Launches",
  audit: "Audit",
  approvals: "Approvals",
  settings: "Settings",
  new: "New",
};

function titleCase(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function looksLikeId(seg: string): boolean {
  // UUIDs, long hex, or numeric ids: keep verbatim rather than title-casing.
  return /^[0-9a-f]{8,}$/i.test(seg) || /^\d+$/.test(seg) || seg.includes("-") === false
    ? /^\d+$/.test(seg) || /^[0-9a-f]{16,}$/i.test(seg)
    : /^[0-9a-f-]{20,}$/i.test(seg);
}

/**
 * Derive breadcrumbs from the current pathname. Each segment becomes a crumb;
 * all but the last link to their cumulative path. A leading Home crumb links
 * to the dashboard.
 */
export function useBreadcrumbs(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: Crumb[] = [];
  let acc = "";
  segments.forEach((seg, i) => {
    acc += `/${seg}`;
    const isLast = i === segments.length - 1;
    const label = SEGMENT_LABELS[seg] ?? (looksLikeId(seg) ? seg : titleCase(seg));
    crumbs.push({ label, href: isLast ? undefined : acc });
  });
  return crumbs;
}

/**
 * Breadcrumb trail rendered below the header. Hidden on the dashboard root
 * (no useful trail there). Accepts an explicit `items` override for pages that
 * want richer labels than the path can express.
 */
export function Breadcrumbs({ items, className }: { items?: Crumb[]; className?: string }) {
  const pathname = usePathname() ?? "/";
  const derived = useBreadcrumbs(pathname);
  const crumbs = items ?? derived;

  if (crumbs.length === 0) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      className={cn(
        "flex items-center gap-1 border-b border-border/60 bg-background/60 px-4 py-2 text-sm text-muted-foreground sm:px-6",
        className,
      )}
    >
      <Link
        href={"/" as Route}
        className="inline-flex items-center gap-1 rounded px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Dashboard"
      >
        <Home className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
      {crumbs.map((crumb, i) => (
        <span key={`${crumb.label}-${i}`} className="inline-flex items-center gap-1">
          <ChevronRight className="h-3.5 w-3.5 opacity-50" aria-hidden="true" />
          {crumb.href ? (
            <Link
              href={crumb.href as Route}
              className="rounded px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {crumb.label}
            </Link>
          ) : (
            <span className="px-1 font-medium text-foreground" aria-current="page">
              {crumb.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
