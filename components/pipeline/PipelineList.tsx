"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Factory } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { useRealtimeStream } from "@/hooks/useRealtimeStream";
import {
  PIPELINE_FORMAT_BADGE,
  PIPELINE_FORMAT_LABEL,
  PIPELINE_STATUS_BADGE,
  PIPELINE_STATUS_LABEL,
  type Pipeline,
  type PipelineFormat,
  type PipelineStatus,
} from "@/lib/pipeline/types";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "in-flight" | "done" | "cancelled";
type FormatFilter = "all" | PipelineFormat;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "in-flight", label: "In flight" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
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
 * Interactive table of pipelines. Renders the SSR-fetched initial set, then
 * subscribes to the `pipelines` realtime channel so new rows / status
 * transitions surface without a manual refresh.
 *
 * Status + format chips filter the visible rows in-memory; we don't refetch
 * on chip changes because the v1 dataset is small.
 */
export function PipelineList({ initialPipelines, clientNames }: PipelineListProps) {
  const router = useRouter();
  const [pipelines, setPipelines] = useState<Pipeline[]>(initialPipelines);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [formatFilter, setFormatFilter] = useState<FormatFilter>("all");

  useEffect(() => {
    setPipelines(initialPipelines);
  }, [initialPipelines]);

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

  const filtered = useMemo(() => {
    return pipelines.filter((p) => {
      if (!matchesStatusFilter(p.status, statusFilter)) return false;
      if (formatFilter !== "all" && p.format_choice !== formatFilter) return false;
      return true;
    });
  }, [pipelines, statusFilter, formatFilter]);

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

      {filtered.length === 0 ? (
        pipelines.length === 0 ? (
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
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="px-3 py-2 font-medium">Format</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Last activity</th>
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
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs",
                          PIPELINE_FORMAT_BADGE[p.format_choice],
                        )}
                      >
                        {PIPELINE_FORMAT_LABEL[p.format_choice]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs",
                          PIPELINE_STATUS_BADGE[p.status],
                        )}
                      >
                        {PIPELINE_STATUS_LABEL[p.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{formatDate(p.created_at)}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatDate(lastActivity(p))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
