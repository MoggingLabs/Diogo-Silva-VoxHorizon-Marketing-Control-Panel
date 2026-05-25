"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  Activity,
  ClipboardList,
  Factory,
  LayoutDashboard,
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

type Nav = { label: string; href: Route; icon: React.ReactNode };

// M0 stub: navigation jumps only. M7 wires this to the `/api/search`
// aggregator over clients/briefs/creatives/launches/pipelines.
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

/**
 * Global command palette (cmd-k / ctrl-k). M0 ships a navigation stub: type to
 * filter and Enter to jump to a section. Controlled by the AppShell which owns
 * the open state and the keyboard shortcut.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();

  const go = React.useCallback(
    (href: Route) => {
      onOpenChange(false);
      router.push(href);
    },
    [router, onOpenChange],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search or jump to..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigate">
          {NAV_COMMANDS.map((cmd) => (
            <CommandItem key={cmd.href} value={cmd.label} onSelect={() => go(cmd.href)}>
              {cmd.icon}
              <span>{cmd.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
