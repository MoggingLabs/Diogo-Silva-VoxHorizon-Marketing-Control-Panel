"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, ClipboardList, Eye, FileVideo, Plus } from "lucide-react";
import { toast } from "sonner";

import { ConfirmArchive } from "@/components/shared/ConfirmArchive";
import {
  DataTable,
  type DataTableColumn,
  type DataTableFilter,
  type DataTableRowAction,
} from "@/components/shared/DataTable";
import { ResourceShell } from "@/components/shared/ResourceShell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { archiveBrief, restoreBrief } from "@/lib/briefs-client";
import type { UnifiedBriefRow } from "@/lib/briefs-unified";

export type BriefsListClientProps = {
  rows: UnifiedBriefRow[];
  /** True when the list is showing archived rows (changes the row actions). */
  archived: boolean;
};

type FormatTab = "all" | "image" | "video";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "posted", label: "Posted" },
  { value: "approved", label: "Approved" },
  { value: "approved_with_changes", label: "Approved w/ changes" },
  { value: "rejected", label: "Rejected" },
];

/**
 * Unified Briefs list (Makeover M3 / E3.1, #590).
 *
 * One section over both `briefs` (image) and `video_briefs` (video) with a
 * format tab (all | image | video), the canonical DataTable (sort + filter +
 * search + bulk-select), bulk archive / restore, and per-row actions. The
 * existing create flows stay reachable via the New menu and the detail pages.
 */
export function BriefsListClient({ rows, archived }: BriefsListClientProps) {
  const router = useRouter();
  const [tab, setTab] = React.useState<FormatTab>("all");
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [working, setWorking] = React.useState(false);

  // The selection carries ids across both tables; we look the row back up to
  // recover its format when acting on it.
  const rowById = React.useMemo(() => {
    const m = new Map<string, UnifiedBriefRow>();
    for (const r of rows) m.set(r.id, r);
    return m;
  }, [rows]);

  const visibleRows = React.useMemo(
    () => (tab === "all" ? rows : rows.filter((r) => r.format === tab)),
    [rows, tab],
  );

  // Keep the selection scoped to what's visible so the bulk bar count is honest.
  const visibleSelection = React.useMemo(
    () => selectedIds.filter((id) => visibleRows.some((r) => r.id === id)),
    [selectedIds, visibleRows],
  );

  async function runArchiveRestore(targetIds: string[]) {
    setWorking(true);
    let okCount = 0;
    const failures: string[] = [];
    for (const id of targetIds) {
      const row = rowById.get(id);
      if (!row) continue;
      try {
        if (archived) await restoreBrief(row.format, id);
        else await archiveBrief(row.format, id);
        okCount += 1;
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    setWorking(false);
    setSelectedIds([]);
    if (okCount > 0) {
      toast.success(
        `${okCount} brief${okCount === 1 ? "" : "s"} ${archived ? "restored" : "archived"}`,
      );
    }
    if (failures.length > 0) {
      toast.error(failures[0]);
    }
    router.refresh();
  }

  async function singleAction(row: UnifiedBriefRow) {
    setWorking(true);
    try {
      if (archived) await restoreBrief(row.format, row.id);
      else await archiveBrief(row.format, row.id);
      toast.success(`Brief ${archived ? "restored" : "archived"}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setWorking(false);
    }
  }

  const columns: DataTableColumn<UnifiedBriefRow>[] = [
    {
      id: "briefIdHuman",
      header: "Brief",
      sortable: true,
      cell: (row) => (
        <Link
          href={row.href}
          className="inline-flex items-center gap-2 font-mono text-xs underline-offset-4 hover:underline"
        >
          {row.format === "video" ? (
            <FileVideo className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ClipboardList className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          )}
          {row.briefIdHuman}
        </Link>
      ),
    },
    {
      id: "format",
      header: "Format",
      sortable: true,
      cell: (row) => <span className="text-sm capitalize">{row.format}</span>,
    },
    {
      id: "clientName",
      header: "Client",
      sortable: true,
      cell: (row) => <span className="text-sm">{row.clientName ?? "—"}</span>,
    },
    {
      id: "serviceMarket",
      header: "Service / market",
      cell: (row) => (
        <span className="text-sm text-muted-foreground">{row.serviceMarket || "—"}</span>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortable: true,
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      id: "createdAt",
      header: "Created",
      sortable: true,
      cell: (row) => (
        <span className="whitespace-nowrap text-sm text-muted-foreground">
          {formatDate(row.createdAt)}
        </span>
      ),
    },
  ];

  const rowActions: DataTableRowAction<UnifiedBriefRow>[] = [
    {
      label: "View",
      icon: <Eye className="h-4 w-4" aria-hidden="true" />,
      onSelect: (row) => router.push(row.href),
    },
    archived
      ? {
          label: "Restore",
          icon: <ArchiveRestore className="h-4 w-4" aria-hidden="true" />,
          onSelect: (row) => void singleAction(row),
        }
      : {
          label: "Archive",
          icon: <Archive className="h-4 w-4" aria-hidden="true" />,
          destructive: true,
          onSelect: (row) => void singleAction(row),
        },
  ];

  const filters: DataTableFilter[] = [{ id: "status", label: "Status", options: STATUS_OPTIONS }];

  return (
    <ResourceShell
      title="Briefs"
      description="Image and video briefs across the pipeline."
      selectedCount={visibleSelection.length}
      onClearSelection={() => setSelectedIds([])}
      bulkActions={[
        archived
          ? {
              label: "Restore",
              icon: <ArchiveRestore className="h-4 w-4" aria-hidden="true" />,
              onClick: () => void runArchiveRestore(visibleSelection),
            }
          : {
              label: "Archive",
              icon: <Archive className="h-4 w-4" aria-hidden="true" />,
              destructive: true,
              onClick: () => setBulkOpen(true),
            },
      ]}
      headerActions={
        <div className="flex items-center gap-2">
          <Tabs value={tab} onValueChange={(v) => setTab(v as FormatTab)}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="image">Image</TabsTrigger>
              <TabsTrigger value="video">Video</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button asChild variant="outline" size="sm">
            <Link href={archived ? "/briefs" : "/briefs?archived=1"}>
              {archived ? "Active" : "Archived"}
            </Link>
          </Button>
          {!archived ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>New brief</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link href="/briefs/new">
                    <ClipboardList className="h-4 w-4" aria-hidden="true" />
                    <span>Image brief</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/briefs/video/new">
                    <FileVideo className="h-4 w-4" aria-hidden="true" />
                    <span>Video brief</span>
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      }
    >
      <DataTable
        columns={columns}
        data={visibleRows}
        getRowId={(row) => row.id}
        searchable
        searchPlaceholder="Search briefs..."
        filters={filters}
        rowActions={rowActions}
        selectable={!working}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        emptyMessage={archived ? "No archived briefs." : "No briefs yet."}
      />

      <ConfirmArchive
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        count={visibleSelection.length}
        resourceName="brief"
        onConfirm={async () => {
          await runArchiveRestore(visibleSelection);
        }}
      />
    </ResourceShell>
  );
}
