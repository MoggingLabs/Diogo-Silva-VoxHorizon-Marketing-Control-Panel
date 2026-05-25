"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  ClipboardList,
  Factory,
  LayoutDashboard,
  Menu,
  Rocket,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
} from "lucide-react";

import { ApprovalModeBadge } from "@/components/approvals/ApprovalModeBadge";
import { ApprovalQueue } from "@/components/approvals/ApprovalQueue";
import { Breadcrumbs } from "@/components/shared/Breadcrumbs";
import { CommandPalette } from "@/components/shared/CommandPalette";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WorkerStatus } from "@/components/WorkerStatus";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type NavItem = {
  href: Route;
  label: string;
  icon: ReactNode;
  /**
   * Optional predicate used to highlight the entry as active for `/foo/[id]`
   * style children. An exact pathname match always wins.
   */
  match?: (pathname: string) => boolean;
};

type NavSection = {
  /** Section heading shown above the group (uppercase, muted). */
  title: string;
  items: NavItem[];
};

// typedRoutes is strict: routes without a `page.tsx` yet (e.g. /clients,
// /approvals) aren't in the generated `Route` union. Cast through `Route` so
// this compiles today; the pages light up as later milestones land them.
const NAV_SECTIONS: NavSection[] = [
  {
    title: "Overview",
    items: [
      {
        href: "/" as Route,
        label: "Dashboard",
        icon: <LayoutDashboard className="h-4 w-4" aria-hidden="true" />,
        match: (p) => p === "/",
      },
    ],
  },
  {
    title: "Operate",
    items: [
      {
        href: "/pipeline" as Route,
        label: "Pipeline",
        icon: <Factory className="h-4 w-4" aria-hidden="true" />,
        match: (p) => p === "/pipeline" || /^\/pipeline(?!\/operator)/.test(p),
      },
      {
        href: "/pipeline/operator" as Route,
        label: "Operator Console",
        icon: <Terminal className="h-4 w-4" aria-hidden="true" />,
        match: (p) => p.startsWith("/pipeline/operator"),
      },
    ],
  },
  {
    title: "Library",
    items: [
      {
        href: "/clients" as Route,
        label: "Clients",
        icon: <Users className="h-4 w-4" aria-hidden="true" />,
        match: (p) => p === "/clients" || p.startsWith("/clients/"),
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
    ],
  },
  {
    title: "Insight",
    items: [
      {
        href: "/audit" as Route,
        label: "Audit",
        icon: <Activity className="h-4 w-4" aria-hidden="true" />,
        match: (p) => p.startsWith("/audit"),
      },
      {
        href: "/approvals" as Route,
        label: "Approvals",
        icon: <ShieldCheck className="h-4 w-4" aria-hidden="true" />,
        match: (p) => p.startsWith("/approvals"),
      },
    ],
  },
  {
    title: "System",
    items: [
      {
        href: "/settings" as Route,
        label: "Settings",
        icon: <Settings className="h-4 w-4" aria-hidden="true" />,
        match: (p) => p.startsWith("/settings"),
      },
    ],
  },
];

function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-4">
      {NAV_SECTIONS.map((section) => (
        <div key={section.title} className="flex flex-col gap-0.5">
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {section.title}
          </p>
          {section.items.map((item) => {
            const isActive = item.match ? item.match(pathname) : pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  "flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors md:min-h-0",
                  isActive
                    ? "bg-primary/12 text-primary"
                    : "text-muted-foreground hover:bg-accent/10 hover:text-foreground",
                )}
                aria-current={isActive ? "page" : undefined}
              >
                {item.icon}
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/**
 * Top-level layout chrome: a header (brand, global-search trigger, theme
 * toggle, approval + worker chrome), a sticky sectioned left sidebar, a
 * breadcrumb trail, and the main content slot. Rendered once at the root
 * layout. Client component because the active-route highlight needs
 * `usePathname()`, the worker status polls, and the command palette + theme
 * toggle are interactive.
 *
 * On screens below `md` the sidebar collapses behind a hamburger that opens a
 * left-sliding `<Sheet>` overlay; desktop keeps the persistent sidebar.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Close the mobile drawer on route change so navigation from inside the
  // sheet doesn't leave it dangling over the next page.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Global cmd-k / ctrl-k opens the command palette.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-border bg-background/95 px-3 py-2 backdrop-blur sm:gap-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-1 sm:gap-2">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                aria-label="Open navigation menu"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
              >
                <Menu className="h-5 w-5" aria-hidden="true" />
              </button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 max-w-[85vw] p-0">
              <SheetHeader className="border-b border-border px-4 py-3">
                <SheetTitle className="text-base">VoxHorizon</SheetTitle>
                <SheetDescription className="text-xs">Marketing Control Panel</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-1 overflow-y-auto p-3">
                <NavList pathname={pathname} onNavigate={() => setMobileOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>
          <Link
            href="/"
            className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-sm font-semibold text-foreground hover:text-foreground/80"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm"
            >
              <span className="text-[11px] font-bold">VH</span>
            </span>
            <span className="hidden truncate sm:inline">VoxHorizon</span>
          </Link>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Search</span>
            <kbd className="hidden items-center gap-0.5 rounded border border-border bg-background px-1.5 font-mono text-[10px] text-muted-foreground sm:inline-flex">
              <span className="text-xs">⌘</span>K
            </kbd>
          </button>
          <ApprovalQueue />
          <ApprovalModeBadge />
          <ThemeToggle />
          <WorkerStatus />
        </div>
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        <aside className="hidden w-60 shrink-0 border-r border-border bg-muted/20 px-3 py-5 md:block">
          <NavList pathname={pathname} />
        </aside>
        {/*
         * Plain div: every page renders its own `<main>` and there must be
         * exactly one per document for assistive tech.
         */}
        <div className="flex min-w-0 flex-1 flex-col">
          <Breadcrumbs />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
