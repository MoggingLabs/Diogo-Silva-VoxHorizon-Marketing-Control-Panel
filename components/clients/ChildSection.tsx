"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, Pencil, Plus } from "lucide-react";
import type { DefaultValues, FieldValues } from "react-hook-form";
import type { ZodType } from "zod";

import { ConfirmArchive } from "@/components/shared/ConfirmArchive";
import { CrudDialog } from "@/components/shared/CrudDialog";
import { Button } from "@/components/ui/button";
import { archiveChild, createChild, updateChild } from "@/lib/clients/api";

export type ChildSectionProps<TRow extends { id: string }, TValues extends FieldValues> = {
  clientId: string;
  /** URL segment + display, e.g. "services". */
  childKey: string;
  /** Singular resource noun for confirm copy, e.g. "service". */
  resourceName: string;
  title: string;
  description?: string;
  rows: TRow[];

  schema: ZodType<TValues>;
  /** Default form values for a fresh create. */
  emptyValues: DefaultValues<TValues>;
  /** Build edit form values from an existing row. */
  toValues: (row: TRow) => DefaultValues<TValues>;
  /** Map validated form values to the API body (e.g. coerce numbers). */
  toBody?: (values: TValues) => unknown;

  /** Render the form fields (inside the CrudDialog FormProvider). */
  renderFields: () => React.ReactNode;
  /** Render the read-only row body in the list. */
  renderRow: (row: TRow) => React.ReactNode;
};

/**
 * Generic CRUD section for a 1:many client config child (E2.4). Renders the
 * rows as a card list with an Add button, per-row Edit (CrudDialog) and Archive
 * (ConfirmArchive). All four reuse the shared M0 components + the client API
 * wrappers, so every child tab behaves identically.
 */
export function ChildSection<TRow extends { id: string }, TValues extends FieldValues>({
  clientId,
  childKey,
  resourceName,
  title,
  description,
  rows,
  schema,
  emptyValues,
  toValues,
  toBody,
  renderFields,
  renderRow,
}: ChildSectionProps<TRow, TValues>) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editRow, setEditRow] = React.useState<TRow | null>(null);
  const [archiveRow, setArchiveRow] = React.useState<TRow | null>(null);

  const body = (values: TValues) => (toBody ? toBody(values) : values);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>Add</span>
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          No {resourceName}s yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-start justify-between gap-3 rounded-md border border-border bg-card px-3 py-2"
            >
              <div className="min-w-0 flex-1 text-sm">{renderRow(row)}</div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`Edit ${resourceName}`}
                  onClick={() => setEditRow(row)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  aria-label={`Archive ${resourceName}`}
                  onClick={() => setArchiveRow(row)}
                >
                  <Archive className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CrudDialog<TValues>
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={`Add ${resourceName}`}
        schema={schema}
        defaultValues={emptyValues}
        successMessage={`${cap(resourceName)} added`}
        onSubmit={async (values) => {
          await createChild(clientId, childKey, body(values));
        }}
        onSuccess={() => router.refresh()}
      >
        {renderFields()}
      </CrudDialog>

      <CrudDialog<TValues>
        open={editRow !== null}
        onOpenChange={(o) => !o && setEditRow(null)}
        title={`Edit ${resourceName}`}
        schema={schema}
        defaultValues={editRow ? toValues(editRow) : emptyValues}
        successMessage={`${cap(resourceName)} updated`}
        onSubmit={async (values) => {
          if (editRow) await updateChild(clientId, childKey, editRow.id, body(values));
        }}
        onSuccess={() => router.refresh()}
      >
        {renderFields()}
      </CrudDialog>

      <ConfirmArchive
        open={archiveRow !== null}
        onOpenChange={(o) => !o && setArchiveRow(null)}
        resourceName={resourceName}
        onConfirm={async () => {
          if (archiveRow) await archiveChild(clientId, childKey, archiveRow.id);
        }}
        onSuccess={() => router.refresh()}
      />
    </section>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
