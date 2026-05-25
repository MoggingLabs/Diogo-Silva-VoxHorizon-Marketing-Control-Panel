"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Film,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  Rows3,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/EmptyState";
import { ConfirmArchive } from "@/components/shared/ConfirmArchive";
import {
  DataTable,
  type DataTableColumn,
  type DataTableRowAction,
} from "@/components/shared/DataTable";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { archiveCreative, restoreCreative } from "@/lib/creatives-client";
import type { CreativeRow } from "@/lib/creatives-rows";
import { cn } from "@/lib/utils";

export type { CreativeRow };

type FormatTab = "all" | "image" | "video";
type ViewMode = "grid" | "table";

export type CreativesGridProps = {
  initialRows: CreativeRow[];
};

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

/**
 * Unified Creatives surface (E4.1 / #593): a thumbnail grid + DataTable view
 * over both `creatives` and `video_creatives`, with a format tab, status
 * filter, search, sort, an active/archived toggle, and per-row manage +
 * archive/restore actions.
 *
 * The initial active set is fetched server-side and passed in; the Archived
 * view is fetched on demand from the client (the list routes hide archived rows
 * by default). Archive/restore go through the CRUD routes and then refresh.
 */
export function CreativesGrid({ initialRows }: CreativesGridProps) {
  const router = useRouter();

  const [formatTab, setFormatTab] = React.useState<FormatTab>("all");
  const [view, setView] = React.useState<ViewMode>("grid");
  const [archivedView, setArchivedView] = React.useState(false);

  // Archived rows are fetched lazily the first time the Archived view opens.
  const [archivedRows, setArchivedRows] = React.useState<CreativeRow[]>([]);
  const [archivedLoading, setArchivedLoading] = React.useState(false);
  const [archivedError, setArchivedError] = React.useState<string | null>(null);
  const [archivedLoaded, setArchivedLoaded] = React.useState(false);

  const [pendingArchive, setPendingArchive] = React.useState<CreativeRow | null>(null);
  const [restoringId, setRestoringId] = React.useState<string | null>(null);

  const loadArchived = React.useCallback(async () => {
    setArchivedLoading(true);
    setArchivedError(null);
    try {
      const res = await fetch("/api/creatives/archived", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load archived creatives (${res.status})`);
      const data = (await res.json()) as { rows: CreativeRow[] };
      setArchivedRows(data.rows);
      setArchivedLoaded(true);
    } catch (err) {
      setArchivedError(err instanceof Error ? err.message : "Failed to load archived creatives.");
    } finally {
      setArchivedLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (archivedView && !archivedLoaded) void loadArchived();
  }, [archivedView, archivedLoaded, loadArchived]);

  const source = archivedView ? archivedRows : initialRows;

  const rows = React.useMemo(
    () => (formatTab === "all" ? source : source.filter((r) => r.kind === formatTab)),
    [source, formatTab],
  );

  const onArchive = React.useCallback(async () => {
    if (!pendingArchive) return;
    await archiveCreative(pendingArchive.kind, pendingArchive.id);
    router.refresh();
  }, [pendingArchive, router]);

  const onRestore = React.useCallback(
    async (row: CreativeRow) => {
      setRestoringId(row.id);
      try {
        await restoreCreative(row.kind, row.id);
        setArchivedRows((prev) => prev.filter((r) => r.id !== row.id));
        toast.success("Creative restored");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not restore creative");
      } finally {
        setRestoringId(null);
      }
    },
    [router],
  );

  const counts = React.useMemo(
    () => ({
      all: source.length,
      image: source.filter((r) => r.kind === "image").length,
      video: source.filter((r) => r.kind === "video").length,
    }),
    [source],
  );

  const columns: DataTableColumn<CreativeRow>[] = React.useMemo(
    () => [
      {
        id: "thumbnail",
        header: "",
        className: "w-16",
        cell: (row) => <Thumb row={row} size="sm" />,
      },
      {
        id: "brief_label",
        header: "Brief",
        sortable: true,
        cell: (row) => (
          <Link
            href={row.href as Route}
            className="font-mono text-xs underline-offset-4 hover:underline"
          >
            {row.brief_label}
          </Link>
        ),
      },
      {
        id: "concept",
        header: "Concept",
        sortable: true,
        cell: (row) => (
          <span className="line-clamp-1 max-w-[22rem]">{row.concept?.trim() || "—"}</span>
        ),
      },
      {
        id: "kind",
        header: "Format",
        sortable: true,
        cell: (row) => (
          <span className="inline-flex items-center gap-1.5 capitalize text-muted-foreground">
            {row.kind === "image" ? (
              <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Film className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {row.kind}
            {row.format_label ? (
              <span className="font-mono text-[11px]"> · {row.format_label}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        cell: (row) => <StatusBadge status={row.status} />,
      },
      {
        id: "version",
        header: "Version",
        sortable: true,
        cell: (row) => <span className="font-mono text-xs">{row.version}</span>,
      },
      {
        id: "created_at",
        header: "Created",
        sortable: true,
        cell: (row) => <span className="text-muted-foreground">{formatDate(row.created_at)}</span>,
      },
      {
        id: "open",
        header: "",
        align: "right",
        cell: (row) => (
          <Link
            href={row.href as Route}
            className="text-xs underline-offset-4 hover:underline"
            aria-label={`Manage creative ${row.brief_label}`}
          >
            Manage
          </Link>
        ),
      },
    ],
    [],
  );

  const rowActions: DataTableRowAction<CreativeRow>[] = React.useMemo(() => {
    if (archivedView) {
      return [
        {
          label: "Restore",
          icon: <ArchiveRestore className="h-4 w-4" aria-hidden="true" />,
          onSelect: (row) => void onRestore(row),
        },
      ];
    }
    return [
      {
        label: "Archive",
        icon: <Archive className="h-4 w-4" aria-hidden="true" />,
        onSelect: (row) => setPendingArchive(row),
      },
    ];
  }, [archivedView, onRestore]);

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar: format tabs + active/archived + view toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1"
          role="tablist"
          aria-label="Creative format"
        >
          {(["all", "image", "video"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={formatTab === tab}
              onClick={() => setFormatTab(tab)}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                formatTab === tab
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab}
              <span className="ml-1.5 text-xs text-muted-foreground">{counts[tab]}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={archivedView ? "default" : "outline"}
            size="sm"
            onClick={() => setArchivedView((v) => !v)}
            aria-pressed={archivedView}
            className="gap-1.5"
          >
            <Archive className="h-3.5 w-3.5" aria-hidden="true" />
            {archivedView ? "Archived" : "Show archived"}
          </Button>
          <div className="inline-flex items-center rounded-lg border border-border p-0.5">
            <Button
              type="button"
              variant={view === "grid" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setView("grid")}
              aria-label="Grid view"
              aria-pressed={view === "grid"}
            >
              <LayoutGrid className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant={view === "table" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setView("table")}
              aria-label="Table view"
              aria-pressed={view === "table"}
            >
              <Rows3 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>

      {archivedView && archivedError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {archivedError}
        </div>
      ) : null}

      {archivedView && archivedLoading ? (
        <div className="flex items-center gap-2 rounded-md border px-3 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading archived creatives…
        </div>
      ) : rows.length === 0 ? (
        archivedView ? (
          <EmptyState
            icon={<Archive className="h-8 w-8" aria-hidden="true" />}
            title="No archived creatives"
            description="Creatives you archive show up here. You can restore them at any time."
          />
        ) : (
          <EmptyState
            icon={<Sparkles className="h-8 w-8" aria-hidden="true" />}
            title="No creatives yet"
            description="Once a brief is approved and the worker produces variants, they show up here."
            action={{ label: "Browse briefs", href: "/briefs" }}
          />
        )
      ) : view === "table" ? (
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(r) => r.id}
          rowActions={rowActions}
          searchable
          searchPlaceholder="Search concept or brief…"
          pageSize={25}
        />
      ) : (
        <ThumbGrid
          rows={rows}
          archivedView={archivedView}
          restoringId={restoringId}
          onArchive={(row) => setPendingArchive(row)}
          onRestore={(row) => void onRestore(row)}
        />
      )}

      <ConfirmArchive
        open={pendingArchive !== null}
        onOpenChange={(open) => {
          if (!open) setPendingArchive(null);
        }}
        resourceName="creative"
        onConfirm={onArchive}
        successMessage="Creative archived"
      />
    </div>
  );
}

function ThumbGrid({
  rows,
  archivedView,
  restoringId,
  onArchive,
  onRestore,
}: {
  rows: CreativeRow[];
  archivedView: boolean;
  restoringId: string | null;
  onArchive: (row: CreativeRow) => void;
  onRestore: (row: CreativeRow) => void;
}) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {rows.map((row) => (
        <li
          key={row.id}
          className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-shadow hover:shadow-md"
        >
          <Link href={row.href as Route} className="block">
            <Thumb row={row} size="lg" />
          </Link>
          <div className="flex flex-1 flex-col gap-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <Link
                href={row.href as Route}
                className="line-clamp-2 text-sm font-medium underline-offset-4 hover:underline"
              >
                {row.concept?.trim() || "Untitled concept"}
              </Link>
              <StatusBadge status={row.status} className="shrink-0" />
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 capitalize">
                {row.kind === "image" ? (
                  <ImageIcon className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <Film className="h-3 w-3" aria-hidden="true" />
                )}
                {row.kind}
              </span>
              {row.format_label ? <span className="font-mono">{row.format_label}</span> : null}
              <span className="font-mono">{row.version}</span>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="font-mono text-[11px] text-muted-foreground">{row.brief_label}</span>
              {archivedView ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5"
                  disabled={restoringId === row.id}
                  onClick={() => onRestore(row)}
                  aria-label={`Restore creative ${row.brief_label}`}
                >
                  {restoringId === row.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  Restore
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-muted-foreground"
                  onClick={() => onArchive(row)}
                  aria-label={`Archive creative ${row.brief_label}`}
                >
                  <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                  Archive
                </Button>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Thumb({ row, size }: { row: CreativeRow; size: "sm" | "lg" }) {
  const box = size === "lg" ? "aspect-video w-full" : "h-12 w-12 rounded-md";
  if (row.thumbnail_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- signed Supabase URLs need a plain <img>
      <img
        src={row.thumbnail_url}
        alt={row.concept ?? "Creative preview"}
        className={cn("bg-muted/40 object-cover", box)}
      />
    );
  }
  return (
    <div
      className={cn("flex items-center justify-center bg-muted/40 text-muted-foreground", box)}
      aria-hidden="true"
    >
      {row.kind === "image" ? (
        <ImageIcon className={size === "lg" ? "h-8 w-8" : "h-5 w-5"} />
      ) : (
        <Film className={size === "lg" ? "h-8 w-8" : "h-5 w-5"} />
      )}
    </div>
  );
}
