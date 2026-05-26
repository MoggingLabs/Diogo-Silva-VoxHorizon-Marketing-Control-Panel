"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Pencil } from "lucide-react";
import { toast } from "sonner";

import { BulkExportButton } from "@/components/shared/BulkExportButton";
import { ConfirmArchive } from "@/components/shared/ConfirmArchive";
import {
  DataTable,
  type DataTableColumn,
  type DataTableRowAction,
} from "@/components/shared/DataTable";
import { ResourceShell } from "@/components/shared/ResourceShell";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { CsvColumn } from "@/lib/export/csv";
import { archiveClient, restoreClient } from "@/lib/clients/api";
import {
  CLIENT_STATUS_OPTIONS,
  SERVICE_TYPE_LABEL,
  SERVICE_TYPE_OPTIONS,
  formatDateTime,
} from "@/lib/clients/labels";
import { type Client } from "@/lib/clients/schemas";

type Row = Pick<
  Client,
  "id" | "name" | "slug" | "service_type" | "status" | "created_at" | "deleted_at"
>;

/** A client's effective status badge: archived rows read "Archived". */
function statusOf(row: Row): string {
  return row.deleted_at ? "archived" : row.status;
}

export function ClientsTable({
  initialClients,
  loadError,
}: {
  initialClients: Row[];
  loadError: string | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<string[]>([]);
  const [archiveTarget, setArchiveTarget] = React.useState<Row | null>(null);
  const [bulkOpen, setBulkOpen] = React.useState(false);

  const columns = React.useMemo<DataTableColumn<Row>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        sortable: true,
        accessor: (r) => r.name,
        cell: (r) => (
          <div className="flex flex-col">
            <Link
              href={`/clients/${r.id}`}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {r.name}
            </Link>
            <span className="font-mono text-xs text-muted-foreground">{r.slug}</span>
          </div>
        ),
      },
      {
        id: "service_type",
        header: "Service",
        sortable: true,
        accessor: (r) => r.service_type,
        cell: (r) => SERVICE_TYPE_LABEL[r.service_type] ?? r.service_type,
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        accessor: (r) => statusOf(r),
        cell: (r) => <StatusBadge status={statusOf(r)} />,
      },
      {
        id: "created_at",
        header: "Created",
        sortable: true,
        accessor: (r) => r.created_at,
        cell: (r) => <span className="text-muted-foreground">{formatDateTime(r.created_at)}</span>,
      },
    ],
    [],
  );

  const rowActions = React.useMemo<DataTableRowAction<Row>[]>(
    () => [
      {
        label: "Edit",
        icon: <Pencil className="h-4 w-4" aria-hidden="true" />,
        onSelect: (r) => router.push(`/clients/${r.id}`),
        disabled: (r) => Boolean(r.deleted_at),
      },
      {
        label: "Archive",
        icon: <Archive className="h-4 w-4" aria-hidden="true" />,
        destructive: true,
        onSelect: (r) => setArchiveTarget(r),
        disabled: (r) => Boolean(r.deleted_at),
      },
      {
        label: "Restore",
        icon: <ArchiveRestore className="h-4 w-4" aria-hidden="true" />,
        onSelect: async (r) => {
          try {
            await restoreClient(r.id);
            toast.success(`${r.name} restored`);
            router.refresh();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not restore client");
          }
        },
        disabled: (r) => !r.deleted_at,
      },
    ],
    [router],
  );

  async function bulkArchive() {
    const ids = selected;
    const results = await Promise.allSettled(ids.map((id) => archiveClient(id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      throw new Error(`${failed} of ${ids.length} could not be archived`);
    }
    setSelected([]);
  }

  // CSV/JSON export columns for the current selection (or all rows when none).
  const exportColumns = React.useMemo<CsvColumn<Row>[]>(
    () => [
      { header: "Name", value: (r) => r.name },
      { header: "Slug", value: (r) => r.slug },
      { header: "Service", value: (r) => SERVICE_TYPE_LABEL[r.service_type] ?? r.service_type },
      { header: "Status", value: (r) => statusOf(r) },
      { header: "Created", value: (r) => r.created_at },
    ],
    [],
  );
  const exportRows = React.useMemo(() => {
    if (selected.length === 0) return initialClients;
    const set = new Set(selected);
    return initialClients.filter((r) => set.has(r.id));
  }, [selected, initialClients]);

  return (
    <>
      <ResourceShell
        title="Clients"
        description="Onboard, edit, and retire the clients the pipeline produces ads for."
        newLabel="New client"
        onNew={() => router.push("/clients/new")}
        newShortcut
        selectedCount={selected.length}
        onClearSelection={() => setSelected([])}
        bulkActions={[
          {
            label: "Archive selected",
            destructive: true,
            icon: <Archive className="h-4 w-4" aria-hidden="true" />,
            onClick: () => setBulkOpen(true),
          },
        ]}
        bulkExtra={
          <BulkExportButton
            rows={exportRows}
            columns={exportColumns}
            filenameBase="clients"
            label="Export selected"
          />
        }
      >
        {loadError ? (
          <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Failed to load clients: {loadError}
          </div>
        ) : null}

        <DataTable<Row>
          columns={columns}
          data={initialClients}
          getRowId={(r) => r.id}
          searchable
          searchPlaceholder="Search by name or slug..."
          filters={[
            { id: "service_type", label: "Service", options: [...SERVICE_TYPE_OPTIONS] },
            { id: "status", label: "Status", options: CLIENT_STATUS_OPTIONS },
          ]}
          rowActions={rowActions}
          selectable
          selectedIds={selected}
          onSelectionChange={setSelected}
          keyboardNav
          onEditRow={(r) => router.push(`/clients/${r.id}`)}
          emptyMessage="No clients yet. Create your first client to get started."
          pageSize={20}
        />
      </ResourceShell>

      <ConfirmArchive
        open={archiveTarget !== null}
        onOpenChange={(o) => !o && setArchiveTarget(null)}
        resourceName="client"
        onConfirm={async () => {
          if (archiveTarget) await archiveClient(archiveTarget.id);
        }}
        onSuccess={() => router.refresh()}
      />

      <ConfirmArchive
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        resourceName="client"
        count={selected.length}
        onConfirm={bulkArchive}
        onSuccess={() => router.refresh()}
      />
    </>
  );
}
