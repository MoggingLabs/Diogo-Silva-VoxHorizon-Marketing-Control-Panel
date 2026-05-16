"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Activity, ClipboardList, LayoutDashboard, Sparkles, Rocket, Settings } from "lucide-react";

import { WorkerStatus } from "@/components/WorkerStatus";
import { cn } from "@/lib/utils";

type NavItem = {
  href: Route;
  label: string;
  icon: ReactNode;
  /**
   * Optional secondary route used to highlight the entry as active. The
   * exact pathname match also wins; this list helps with `/foo/[id]` style
   * children.
   */
  match?: (pathname: string) => boolean;
};

// typedRoutes is strict: routes that don't yet have a `page.tsx` (launches,
// audit, creatives index) aren't in the generated `Route` union. The nav
// links to them anyway since other Wave 4 agents are landing the pages in
// parallel — cast through `Route` so this compiles today and lights up
// naturally tomorrow.
const NAV: NavItem[] = [
  {
    href: "/" as Route,
    label: "Dashboard",
    icon: <LayoutDashboard className="h-4 w-4" aria-hidden="true" />,
    match: (p) => p === "/",
  },
  {
    href: "/briefs" as Route,
    label: "Briefs",
    icon: <ClipboardList className="h-4 w-4" aria-hidden="true" />,
    match: (p) => p === "/briefs" || p.startsWith("/briefs/"),
  },
  {
    href: "/creatives" as Route,
    label: "Creatives",
    icon: <Sparkles className="h-4 w-4" aria-hidden="true" />,
    match: (p) => p.startsWith("/creatives"),
  },
  {
    href: "/launches" as Route,
    label: "Launches",
    icon: <Rocket className="h-4 w-4" aria-hidden="true" />,
    match: (p) => p.startsWith("/launches"),
  },
  {
    href: "/audit" as Route,
    label: "Audit",
    icon: <Activity className="h-4 w-4" aria-hidden="true" />,
    match: (p) => p.startsWith("/audit"),
  },
  {
    href: "/settings" as Route,
    label: "Settings",
    icon: <Settings className="h-4 w-4" aria-hidden="true" />,
    match: (p) => p.startsWith("/settings"),
  },
];

/**
 * Top-level layout chrome: header with brand + worker status, sticky left
 * sidebar nav, and a main content slot. Rendered once at the root layout so
 * every page picks it up. Client component because the active route highlight
 * needs `usePathname()` and the worker status polls.
 *
 * The sidebar is hidden on small screens and the routes still work via
 * direct navigation; a full mobile sweep lands in M5-6.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-2 backdrop-blur sm:px-6">
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md px-1 py-1 text-sm font-semibold text-foreground hover:text-foreground/80"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground"
            >
              <span className="text-[11px] font-bold">VH</span>
            </span>
            <span className="hidden sm:inline">VoxHorizon</span>
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <WorkerStatus />
        </div>
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        <aside className="hidden w-56 shrink-0 border-r border-border bg-muted/20 px-3 py-4 md:block">
          <nav aria-label="Primary" className="flex flex-col gap-0.5">
            {NAV.map((item) => {
              const isActive = item.match ? item.match(pathname) : pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                  aria-current={isActive ? "page" : undefined}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </aside>
        {/*
         * Use a plain div here: every page renders its own `<main>` and there
         * must be exactly one per document for assistive tech.
         */}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
