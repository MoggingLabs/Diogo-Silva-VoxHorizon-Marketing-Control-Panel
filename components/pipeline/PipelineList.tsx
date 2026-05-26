"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Factory, Loader2, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/EmptyState";
import { ConfirmArchive } from "@/components/shared/ConfirmArchive";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useRealtimeStream } from "@/hooks/useRealtimeStream";
import { archivePipeline, listPipelines, restorePipeline } from "@/lib/pipeline/client";
import { type Pipeline, type PipelineFormat, type PipelineStatus } from "@/lib/pipeline/types";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "in-flight" | "done" | "cancelled" | "archived";
type FormatFilter = "all" | PipelineFormat;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "in-flight", label: "In flight" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
  { value: "archived", label: "Archived" },
];

const FORMAT_FILTERS: { value: FormatFilter; label: string }[] = [
  { value: "all", label: "All formats" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "both", label: "Image + Video" },
];

const IN_FLIGHT_STATUSES: PipelineStatus[] = ["configuration", "ideation", "review", "generation"];

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function matchesStatusFilter(status: PipelineStatus, filter: StatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "in-flight":
      return IN_FLIGHT_STATUSES.includes(status);
    case "done":
      return status === "done";
    case "cancelled":
      return status === "cancelled";
    case "archived":
      // The archived view uses a separate fetched data set, not a status
      // predicate, so every fetched row qualifies.
      return true;
  }
}

function lastActivity(p: Pipeline): string {
  return p.updated_at ?? p.created_at;
}

export type PipelineListProps = {
  initialPipelines: Pipeline[];
  clientNames: Record<string, string>;
};

/**
 * Interactive table of pipelines. Renders the SSR-fetched initial set (active
 * rows only), then subscribes to the `pipelines` realtime channel so new rows
 * / status transitions surface without a manual refresh.
 *
 * Status + format chips filter the visible rows in-memory; the "Archived" chip
 * is special: archived rows are excluded from the default API list (migration
 * 0048 `deleted_at`), so selecting it fetches the archived set on demand and
 * swaps in the Restore action per row. The active view exposes a per-row
 * Archive action (soft-delete, confirmed + reversible).
 */
export function PipelineList({ initialPipelines, clientNames }: PipelineListProps) {
  const router = useRouter();
  const [pipelines, setPipelines] = useState<Pipeline[]>(initialPipelines);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [formatFilter, setFormatFilter] = useState<FormatFilter>("all");

  // Archived rows are fetched lazily the first time the operator opens the
  // Archived view (and re-fetched after a restore so the list stays accurate).
  const [archived, setArchived] = useState<Pipeline[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState<string | null>(null);

  // Confirm-archive dialog state: holds the row being archived.
  const [pendingArchive, setPendingArchive] = useState<Pipeline | null>(null);
  // Per-row restore in-flight guard (keyed by pipeline id).
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const isArchivedView = statusFilter === "archived";

  useEffect(() => {
    setPipelines(initialPipelines);
  }, [initialPipelines]);

  const loadArchived = useCallback(async () => {
    setArchivedLoading(true);
    setArchivedError(null);
    try {
      const res = await listPipelines({ limit: 200, archived: true });
      setArchived(res.pipelines);
    } catch (err) {
      setArchivedError(err instanceof Error ? err.message : "Failed to load archived pipelines.");
    } finally {
      setArchivedLoading(false);
    }
  }, []);

  // Fetch the archived set the first time (or whenever) the Archived view opens.
  useEffect(() => {
    if (isArchivedView) void loadArchived();
  }, [isArchivedView, loadArchived]);

  useRealtimeStream(
    useMemo(
      () => [
        {
          table: "pipelines",
          event: "*" as const,
          // Easiest correct path: let the server re-query. Keeps client
          // joins to the clients table accurate without re-deriving here.
          callback: () => router.refresh(),
        },
      ],
      [router],
    ),
  );

  const source = isArchivedView ? archived : pipelines;

  const filtered = useMemo(() => {
    return source.filter((p) => {
      if (!matchesStatusFilter(p.status, statusFilter)) return false;
      if (formatFilter !== "all" && p.format_choice !== formatFilter) return false;
      return true;
    });
  }, [source, statusFilter, formatFilter]);

  const onArchive = useCallback(async () => {
    if (!pendingArchive) return;
    const target = pendingArchive;
    await archivePipeline(target.id);
    // Drop the row from the active list immediately; the realtime refresh
    // reconciles the SSR set on the next round trip.
    setPipelines((prev) => prev.filter((p) => p.id !== target.id));
  }, [pendingArchive]);

  const onRestore = useCallback(
    async (target: Pipeline) => {
      setRestoringId(target.id);
      try {
        await restorePipeline(target.id);
        setArchived((prev) => prev.filter((p) => p.id !== target.id));
        toast.success("Pipeline restored");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not restore pipeline");
      } finally {
        setRestoringId(null);
      }
    },
    [router],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <ChipGroup
            label="Status"
            value={statusFilter}
            options={STATUS_FILTERS}
            onChange={(v) => setStatusFilter(v as StatusFilter)}
          />
          <ChipGroup
            label="Format"
            value={formatFilter}
            options={FORMAT_FILTERS}
            onChange={(v) => setFormatFilter(v as FormatFilter)}
          />
        </div>
        <Button asChild className="self-start sm:self-auto">
          <Link href="/pipeline/new">Start new pipeline</Link>
        </Button>
      </div>

      {isArchivedView && archivedError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {archivedError}
        </div>
      ) : null}

      {isArchivedView && archivedLoading ? (
        <div className="flex items-center gap-2 rounded-md border px-3 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading archived pipelines…
        </div>
      ) : filtered.length === 0 ? (
        isArchivedView ? (
          <EmptyState
            icon={<Archive className="h-8 w-8" aria-hidden="true" />}
            title="No archived pipelines"
            description="Pipelines you archive show up here. You can restore them at any time."
          />
        ) : source.length === 0 ? (
          <EmptyState
            icon={<Factory className="h-8 w-8" aria-hidden="true" />}
            title="No pipelines yet"
            description="Kick off your first pipeline to walk a brief through ideation, review, generation, and launch."
            action={{ label: "Start new pipeline", href: "/pipeline/new" }}
          />
        ) : (
          <EmptyState
            icon={<Factory className="h-8 w-8" aria-hidden="true" />}
            title="No pipelines match these filters"
            description="Try a different status or format chip."
          />
        )
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="px-3 py-2 font-medium">Format</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Last activity</th>
                <th className="px-3 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const clientName = p.client_id
                  ? (clientNames[p.client_id] ?? p.client_id.slice(0, 8))
                  : "Unassigned";
                return (
                  <tr key={p.id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <Link
                        href={`/pipeline/${p.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {clientName}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={p.format_choice} />
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{formatDate(p.created_at)}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatDate(lastActivity(p))}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isArchivedView ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          disabled={restoringId === p.id}
                          onClick={() => void onRestore(p)}
                          aria-label="Restore pipeline"
                        >
                          {restoringId === p.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          Restore
                        </Button>
                      ) : (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                              aria-label="Pipeline actions"
                            >
                              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setPendingArchive(p)}>
                              <Archive className="h-4 w-4" aria-hidden="true" />
                              Archive
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmArchive
        open={pendingArchive !== null}
        onOpenChange={(open) => {
          if (!open) setPendingArchive(null);
        }}
        resourceName="pipeline"
        onConfirm={onArchive}
        successMessage="Pipeline archived"
      />
    </div>
  );
}

function ChipGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
