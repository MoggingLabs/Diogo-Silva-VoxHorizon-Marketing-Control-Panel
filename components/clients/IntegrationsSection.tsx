"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, KeyRound, Pencil, Plus } from "lucide-react";

import { ConfirmArchive } from "@/components/shared/ConfirmArchive";
import { CrudDialog } from "@/components/shared/CrudDialog";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SelectField, TextField, TextareaField } from "@/components/clients/fields";
import { archiveIntegration, createIntegration, updateIntegration } from "@/lib/clients/api";
import { INTEGRATION_PROVIDER_OPTIONS } from "@/lib/clients/labels";
import { type ClientIntegration } from "@/lib/clients/schemas";
import { z } from "zod";

/**
 * Integrations tab (E2.4 / E2.3). Lists a client's integrations with provider,
 * external id, masked config, and active state. Add / edit / archive via
 * CrudDialog + ConfirmArchive. Config is entered as JSON text; secrets come
 * back masked from the API, so editing config requires re-entering credentials
 * (the form starts empty for config on edit by design).
 */

const IntegrationFormSchema = z.object({
  provider: z.enum(["meta", "ghl", "drive"]),
  external_id: z.string().max(500).optional(),
  config_json: z
    .string()
    .optional()
    .refine(
      (v) => {
        if (!v || v.trim().length === 0) return true;
        try {
          JSON.parse(v);
          return true;
        } catch {
          return false;
        }
      },
      { message: "Config must be valid JSON" },
    ),
  active: z.enum(["true", "false"]),
});
type IntegrationForm = z.infer<typeof IntegrationFormSchema>;

const EMPTY: IntegrationForm = {
  provider: "meta",
  external_id: "",
  config_json: "",
  active: "true",
};

function toBody(v: IntegrationForm) {
  return {
    provider: v.provider,
    external_id: v.external_id?.trim() ? v.external_id.trim() : null,
    config: v.config_json && v.config_json.trim() ? JSON.parse(v.config_json) : {},
    active: v.active === "true",
  };
}

function Fields() {
  return (
    <>
      <SelectField<IntegrationForm>
        name="provider"
        label="Provider"
        options={INTEGRATION_PROVIDER_OPTIONS}
      />
      <TextField<IntegrationForm>
        name="external_id"
        label="External id"
        placeholder="act_123 / location id / folder id"
      />
      <TextareaField<IntegrationForm>
        name="config_json"
        label="Config (JSON)"
        rows={5}
        placeholder='{"api_key": "..."}'
      />
      <SelectField<IntegrationForm>
        name="active"
        label="Active"
        options={[
          { value: "true", label: "Active" },
          { value: "false", label: "Inactive" },
        ]}
      />
    </>
  );
}

export function IntegrationsSection({
  clientId,
  integrations,
}: {
  clientId: string;
  integrations: ClientIntegration[];
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editRow, setEditRow] = React.useState<ClientIntegration | null>(null);
  const [archiveRow, setArchiveRow] = React.useState<ClientIntegration | null>(null);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Integrations</h2>
          <p className="text-sm text-muted-foreground">
            Meta / GoHighLevel / Drive connections. Secrets are masked.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>Add</span>
        </Button>
      </div>

      {integrations.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          No integrations yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {integrations.map((row) => (
            <li
              key={row.id}
              className="flex items-start justify-between gap-3 rounded-md border border-border bg-card px-3 py-2"
            >
              <div className="min-w-0 flex-1 space-y-1 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium capitalize text-foreground">{row.provider}</span>
                  <StatusBadge status={row.active ? "active" : "inactive"} />
                </div>
                {row.external_id ? (
                  <p className="font-mono text-xs text-muted-foreground">{row.external_id}</p>
                ) : null}
                <pre className="overflow-x-auto rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
                  <KeyRound className="mr-1 inline h-3 w-3" aria-hidden="true" />
                  {JSON.stringify(row.config)}
                </pre>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Edit integration"
                  onClick={() => setEditRow(row)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  aria-label="Archive integration"
                  onClick={() => setArchiveRow(row)}
                >
                  <Archive className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CrudDialog<IntegrationForm>
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Add integration"
        schema={IntegrationFormSchema}
        defaultValues={EMPTY}
        successMessage="Integration added"
        onSubmit={async (values) => {
          await createIntegration(clientId, toBody(values));
        }}
        onSuccess={() => router.refresh()}
      >
        <Fields />
      </CrudDialog>

      <CrudDialog<IntegrationForm>
        open={editRow !== null}
        onOpenChange={(o) => !o && setEditRow(null)}
        title="Edit integration"
        description="Re-enter config credentials to change them (existing secrets are masked)."
        schema={IntegrationFormSchema}
        defaultValues={
          editRow
            ? {
                provider: editRow.provider as IntegrationForm["provider"],
                external_id: editRow.external_id ?? "",
                config_json: "",
                active: editRow.active ? "true" : "false",
              }
            : EMPTY
        }
        successMessage="Integration updated"
        onSubmit={async (values) => {
          if (editRow) await updateIntegration(clientId, editRow.id, toBody(values));
        }}
        onSuccess={() => router.refresh()}
      >
        <Fields />
      </CrudDialog>

      <ConfirmArchive
        open={archiveRow !== null}
        onOpenChange={(o) => !o && setArchiveRow(null)}
        resourceName="integration"
        onConfirm={async () => {
          if (archiveRow) await archiveIntegration(clientId, archiveRow.id);
        }}
        onSuccess={() => router.refresh()}
      />
    </section>
  );
}
