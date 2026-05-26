"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";

import { ConfirmArchive } from "@/components/shared/ConfirmArchive";
import {
  DataTable,
  type DataTableColumn,
  type DataTableRowAction,
} from "@/components/shared/DataTable";
import { ResourceShell, type BulkAction } from "@/components/shared/ResourceShell";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  archiveLaunch,
  listLaunches,
  restoreLaunch,
  type LaunchFormat,
  type LaunchListRow,
} from "@/lib/launches/client";

/**
 * Unified Launches management surface (E5.1 / #595).
 *
 * One section over BOTH the image (``launch_packages``) and video
 * (``video_launch_packages``) tables, switched by a format tab — the makeover's
 * "unify image/video, keep dual tables" decision. The active set is rendered in
 * the shared DataTable (brief id, client, status, created) with sort/filter,
 * per-row + bulk soft-archive, and an Archived view that swaps in Restore. The
 * launch decision itself is NOT here: the operator opens a package and decides
 * through the existing decision route (which re-derives the gate).
 */

type ArchiveTab = "active" | "archived";

/** A row enriched with the brief id + client name parsed from the payload. */
export type LaunchRowView = LaunchListRow & {
  briefHuman: string;
  clientName: string;
};

function readPayloadMeta(row: LaunchListRow): { briefHuman: string; clientName: string } {
  const payload = row.payload as
    | { brief_id_human?: unknown; client?: { name?: unknown } | null }
    | null
    | undefined;
  const briefHuman =
    payload && typeof payload.brief_id_human === "string" && payload.brief_id_human
      ? payload.brief_id_human
      : row.brief_id.slice(0, 8);
  const clientName =
    payload && payload.client && typeof payload.client.name === "string"
      ? payload.client.name
      : "—";
  return { briefHuman, clientName };
}

function toView(row: LaunchListRow): LaunchRowView {
  return { ...row, ...readPayloadMeta(row) };
}

const STATUS_OPTIONS = [
  { value: "validating", label: "Validating" },
  { value: "posted", label: "Posted" },
  { value: "approved", label: "Approved" },
  { value: "approved_with_changes", label: "Approved with changes" },
  { value: "rejected", label: "Rejected" },
  { value: "failed", label: "Failed" },
];

export type LaunchesManagerProps = {
  /** SSR-seeded active rows per format so first paint has data. */
  initialImage: LaunchListRow[];
  initialVideo: LaunchListRow[];
};

export function LaunchesManager({ initialImage, initialVideo }: LaunchesManagerProps) {
  const router = useRouter();
  const [format, setFormat] = React.useState<LaunchFormat>("image");
  const [archiveTab, setArchiveTab] = React.useState<ArchiveTab>("active");

  // Per-format active sets, seeded from SSR.
  const [active, setActive] = React.useState<Record<LaunchFormat, LaunchListRow[]>>({
    image: initialImage,
    video: initialVideo,
  });
  // Archived sets are fetched lazily when the Archived view first opens.
  const [archived, setArchived] = React.useState<Record<LaunchFormat, LaunchListRow[] | null>>({
    image: null,
    video: null,
  });
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [pendingArchive, setPendingArchive] = React.useState<LaunchRowView | null>(null);
  const [bulkArchiveOpen, setBulkArchiveOpen] = React.useState(false);

  React.useEffect(() => {
    setActive({ image: initialImage, video: initialVideo });
  }, [initialImage, initialVideo]);

  // Reset selection whenever the visible set changes.
  React.useEffect(() => {
    setSelectedIds([]);
  }, [format, archiveTab]);

  const isArchivedView = archiveTab === "archived";

  const loadArchived = React.useCallback(async (fmt: LaunchFormat) => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listLaunches(fmt, { archived: true });
      setArchived((prev) => ({ ...prev, [fmt]: rows }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load archived launches.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (isArchivedView && archived[format] === null) void loadArchived(format);
  }, [isArchivedView, format, archived, loadArchived]);

  const refreshActive = React.useCallback(async (fmt: LaunchFormat) => {
    try {
      const rows = await listLaunches(fmt);
      setActive((prev) => ({ ...prev, [fmt]: rows }));
    } catch {
      // best-effort; the SSR refresh below reconciles anyway
    }
  }, []);

  const rows = React.useMemo<LaunchRowView[]>(() => {
    const source = isArchivedView ? (archived[format] ?? []) : active[format];
    return source.map(toView);
  }, [isArchivedView, archived, active, format]);

  const onArchiveConfirm = React.useCallback(async () => {
    if (!pendingArchive) return;
    const target = pendingArchive;
    await archiveLaunch(format, target.id);
    setActive((prev) => ({
      ...prev,
      [format]: prev[format].filter((r) => r.id !== target.id),
    }));
  }, [pendingArchive, format]);

  const onBulkArchiveConfirm = React.useCallback(async () => {
    const ids = [...selectedIds];
    const results = await Promise.allSettled(ids.map((id) => archiveLaunch(format, id)));
    const succeeded = new Set(ids.filter((_, i) => results[i]?.status === "fulfilled"));
    setActive((prev) => ({
      ...prev,
      [format]: prev[format].filter((r) => !succeeded.has(r.id)),
    }));
    setSelectedIds([]);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) throw new Error(`${failed} of ${ids.length} could not be archived`);
  }, [selectedIds, format]);

  const onRestore = React.useCallback(
    async (target: LaunchRowView) => {
      try {
        await restoreLaunch(format, target.id);
        setArchived((prev) => ({
          ...prev,
          [format]: (prev[format] ?? []).filter((r) => r.id !== target.id),
        }));
        toast.success("Launch restored");
        await refreshActive(format);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not restore launch");
      }
    },
    [format, refreshActive, router],
  );

  const detailHref = React.useCallback(
    (row: LaunchRowView): Route =>
      (format === "video" ? `/launches/video/${row.id}` : `/launches/${row.id}`) as Route,
    [format],
  );

  const columns = React.useMemo<DataTableColumn<LaunchRowView>[]>(
    () => [
      {
        id: "briefHuman",
        header: "Brief",
        sortable: true,
        accessor: (r) => r.briefHuman,
        cell: (r) => (
          <Link
            href={detailHref(r)}
            className="font-medium underline-offset-4 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {r.briefHuman}
          </Link>
        ),
      },
      {
        id: "clientName",
        header: "Client",
        sortable: true,
        accessor: (r) => r.clientName,
        cell: (r) => <span className="text-muted-foreground">{r.clientName}</span>,
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        accessor: (r) => r.status,
        cell: (r) => <StatusBadge status={r.status} />,
      },
      {
        id: "created_at",
        header: "Created",
        sortable: true,
        accessor: (r) => r.created_at,
        cell: (r) => (
          <span className="text-muted-foreground">
            {new Date(r.created_at).toLocaleDateString()}
          </span>
        ),
      },
    ],
    [detailHref],
  );

  const rowActions = React.useMemo<DataTableRowAction<LaunchRowView>[]>(() => {
    if (isArchivedView) {
      return [
        {
          label: "Restore",
          icon: <ArchiveRestore className="h-4 w-4" aria-hidden="true" />,
          onSelect: (r) => void onRestore(r),
        },
      ];
    }
    return [
      {
        label: "Archive",
        icon: <Archive className="h-4 w-4" aria-hidden="true" />,
        destructive: true,
        onSelect: (r) => setPendingArchive(r),
      },
    ];
  }, [isArchivedView, onRestore]);

  const bulkActions = React.useMemo<BulkAction[]>(() => {
    if (isArchivedView) return [];
    return [
      {
        label: "Archive",
        destructive: true,
        icon: <Archive className="h-4 w-4" aria-hidden="true" />,
        onClick: () => setBulkArchiveOpen(true),
      },
    ];
  }, [isArchivedView]);

  return (
    <ResourceShell
      title="Launches"
      description="Image and video launch packages. Open a package to review the bundle and decide."
      selectedCount={isArchivedView ? 0 : selectedIds.length}
      bulkActions={bulkActions}
      onClearSelection={() => setSelectedIds([])}
      headerActions={
        <div className="flex items-center gap-2">
          <Tabs value={format} onValueChange={(v) => setFormat(v as LaunchFormat)}>
            <TabsList>
              <TabsTrigger value="image">Image</TabsTrigger>
              <TabsTrigger value="video">Video</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs value={archiveTab} onValueChange={(v) => setArchiveTab(v as ArchiveTab)}>
            <TabsList>
              <TabsTrigger value="active">Active</TabsTrigger>
              <TabsTrigger value="archived">Archived</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      }
    >
      {error ? (
        <div
          role="alert"
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <DataTable<LaunchRowView>
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        loading={loading}
        searchable
        searchPlaceholder="Search brief or client..."
        filters={[{ id: "status", label: "Status", options: STATUS_OPTIONS }]}
        rowActions={rowActions}
        selectable={!isArchivedView}
        selectedIds={isArchivedView ? [] : selectedIds}
        onSelectionChange={setSelectedIds}
        emptyMessage={
          isArchivedView
            ? "No archived launches. Archived packages show up here."
            : "No launches yet. Build one from an approved brief."
        }
      />

      <ConfirmArchive
        open={pendingArchive !== null}
        onOpenChange={(open) => {
          if (!open) setPendingArchive(null);
        }}
        resourceName="launch"
        onConfirm={onArchiveConfirm}
        successMessage="Launch archived"
      />

      <ConfirmArchive
        open={bulkArchiveOpen}
        onOpenChange={setBulkArchiveOpen}
        count={selectedIds.length}
        resourceName="launch"
        onConfirm={onBulkArchiveConfirm}
      />
    </ResourceShell>
  );
}
