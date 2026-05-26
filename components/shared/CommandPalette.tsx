"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  Activity,
  ClipboardList,
  Factory,
  FileVideo,
  LayoutDashboard,
  Loader2,
  Rocket,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  groupSearchResults,
  searchResources,
  type SearchResult,
  type SearchResultKind,
} from "@/lib/search/client";

type Nav = { label: string; href: Route; icon: React.ReactNode };

// Navigation jumps shown when the query is empty (the palette's "home" view).
// Once the operator types, live `/api/search` results take over.
const NAV_COMMANDS: Nav[] = [
  { label: "Dashboard", href: "/" as Route, icon: <LayoutDashboard /> },
  { label: "Pipeline", href: "/pipeline" as Route, icon: <Factory /> },
  { label: "Operator Console", href: "/pipeline/operator" as Route, icon: <Terminal /> },
  { label: "Clients", href: "/clients" as Route, icon: <Users /> },
  { label: "Briefs", href: "/briefs" as Route, icon: <ClipboardList /> },
  { label: "Creatives", href: "/creatives" as Route, icon: <Sparkles /> },
  { label: "Launches", href: "/launches" as Route, icon: <Rocket /> },
  { label: "Audit", href: "/audit" as Route, icon: <Activity /> },
  { label: "Approvals", href: "/approvals" as Route, icon: <ShieldCheck /> },
  { label: "Settings", href: "/settings" as Route, icon: <Settings /> },
];

/** Per-kind leading icon for a search result row. */
function resultIcon(kind: SearchResultKind): React.ReactNode {
  switch (kind) {
    case "client":
      return <Users />;
    case "brief":
      return <ClipboardList />;
    case "video_brief":
      return <FileVideo />;
    case "creative":
      return <Sparkles />;
    case "video_creative":
      return <FileVideo />;
    case "launch_package":
    case "video_launch_package":
      return <Rocket />;
    case "pipeline":
      return <Factory />;
  }
}

/** How long to wait after the last keystroke before hitting `/api/search`. */
const DEBOUNCE_MS = 200;

/**
 * Global command palette (cmd-k / ctrl-k). Two modes:
 *
 *  - Empty query: a navigation list (jump to a section).
 *  - Non-empty query: debounced live results from the `/api/search` aggregator
 *    across clients / briefs / creatives / launches / pipelines, grouped by
 *    kind, each deep-linking to the resource.
 *
 * Controlled by the AppShell which owns the open state + the keyboard shortcut.
 * cmdk's built-in client filter is disabled (`shouldFilter={false}`) because the
 * server already ranked + filtered the results.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [loading, setLoading] = React.useState(false);

  const go = React.useCallback(
    (href: string) => {
      onOpenChange(false);
      // Runtime-built hrefs from search aren't in the typedRoutes union; the
      // route is a real app path, so cast at this boundary.
      router.push(href as Route);
    },
    [router, onOpenChange],
  );

  // Reset the query + results each time the palette closes so reopening starts
  // clean (no stale results flashing before the next search).
  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setLoading(false);
    }
  }, [open]);

  // Debounced live search. Aborts the in-flight request when the query changes
  // or the palette closes so a slow response can't clobber a newer one.
  React.useEffect(() => {
    const trimmed = query.trim();
    if (!open || trimmed.length === 0) {
      setResults([]);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      searchResources(trimmed, controller.signal)
        .then((rows) => {
          setResults(rows);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setResults([]);
          setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);

  const trimmed = query.trim();
  const showNav = trimmed.length === 0;
  const groups = React.useMemo(() => groupSearchResults(results), [results]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} commandProps={{ shouldFilter: false }}>
      <CommandInput
        placeholder="Search clients, briefs, creatives, launches..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {showNav ? (
          <>
            <CommandGroup heading="Navigate">
              {NAV_COMMANDS.map((cmd) => (
                <CommandItemRow
                  key={cmd.href}
                  value={`nav:${cmd.label}`}
                  icon={cmd.icon}
                  label={cmd.label}
                  onSelect={() => go(cmd.href)}
                />
              ))}
            </CommandGroup>
            <div
              role="note"
              aria-label="Keyboard shortcuts"
              className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground"
            >
              <span className="font-medium">Shortcuts: </span>
              <kbd className="rounded border border-border bg-background px-1 font-mono">n</kbd> new
              {", "}
              <kbd className="rounded border border-border bg-background px-1 font-mono">
                ↑↓
              </kbd>{" "}
              move
              {", "}
              <kbd className="rounded border border-border bg-background px-1 font-mono">
                e
              </kbd>{" "}
              edit
              {", "}
              <kbd className="rounded border border-border bg-background px-1 font-mono">
                Esc
              </kbd>{" "}
              close
            </div>
          </>
        ) : (
          <>
            {loading ? (
              <div
                role="status"
                className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"
              >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Searching...</span>
              </div>
            ) : (
              <CommandEmpty>No results for &ldquo;{trimmed}&rdquo;.</CommandEmpty>
            )}
            {groups.map((group) => (
              <CommandGroup key={group.heading} heading={group.heading}>
                {group.items.map((r) => (
                  <CommandItemRow
                    key={`${r.kind}:${r.id}`}
                    value={`${r.kind}:${r.id}`}
                    icon={resultIcon(r.kind)}
                    label={r.label}
                    onSelect={() => go(r.href)}
                  />
                ))}
              </CommandGroup>
            ))}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

/**
 * A single palette row. Pulled out so the nav list and the search groups share
 * identical markup. `value` is the cmdk selection key (we set unique keys so
 * arrow-key navigation is stable even when labels collide).
 */
function CommandItemRow({
  value,
  icon,
  label,
  onSelect,
}: {
  value: string;
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={value} onSelect={onSelect}>
      {icon}
      <span className="truncate">{label}</span>
    </CommandItem>
  );
}
