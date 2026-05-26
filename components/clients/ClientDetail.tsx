"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Pencil } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { ChildSection } from "@/components/clients/ChildSection";
import { IntegrationsSection } from "@/components/clients/IntegrationsSection";
import { ProfileSection } from "@/components/clients/ProfileSection";
import { SelectField, TextField, TextareaField } from "@/components/clients/fields";
import { ConfirmArchive } from "@/components/shared/ConfirmArchive";
import { CrudDialog } from "@/components/shared/CrudDialog";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { archiveClient, restoreClient, updateClient } from "@/lib/clients/api";
import {
  ASSET_KIND_OPTIONS,
  ASSET_SOURCE_OPTIONS,
  CLIENT_STATUS_OPTIONS,
  SERVICE_TYPE_LABEL,
  SERVICE_TYPE_OPTIONS,
  VALUE_PROP_KIND_LABEL,
  formatDateTime,
} from "@/lib/clients/labels";
import type {
  Client,
  ClientAsset,
  ClientIntegration,
  ClientOffer,
  ClientOfferConstraint,
  ClientPastProject,
  ClientProfile,
  ClientService,
  ClientValueProp,
} from "@/lib/clients/schemas";

export type ClientActivity = {
  id: string;
  kind: string;
  payload: unknown;
  created_at: string;
};

type Props = {
  client: Client;
  profile: ClientProfile | null;
  services: ClientService[];
  valueProps: ClientValueProp[];
  offers: ClientOffer[];
  constraints: ClientOfferConstraint[];
  assets: ClientAsset[];
  pastProjects: ClientPastProject[];
  integrations: ClientIntegration[];
  activity: ClientActivity[];
};

// --- per-child form schemas (string form fields, coerced on submit) ---------

const serviceSchema = z.object({ service_name: z.string().min(1, "Required").max(500) });
const valuePropSchema = z.object({
  kind: z.enum(["usp", "differentiator"]),
  prop_text: z.string().min(1, "Required").max(2000),
});
const offerSchema = z.object({
  offer_text: z.string().min(1, "Required").max(2000),
  active: z.enum(["true", "false"]),
});
const constraintSchema = z.object({ constraint_text: z.string().min(1, "Required").max(2000) });
const assetSchema = z.object({
  kind: z.enum([
    "logo",
    "logo_alt",
    "facebook_banner",
    "review",
    "team_photo",
    "project_photo",
    "external",
    "existing_creative",
  ]),
  source: z.enum(["drive", "local", "url", "filename", "descriptor"]),
  ref: z.string().min(1, "Required").max(4000),
  label: z.string().max(500).optional(),
  formats: z.string().max(200).optional(),
});
const pastProjectSchema = z.object({ url: z.string().url("Must be a URL").max(2048) });

const clientEditSchema = z.object({
  name: z.string().min(1, "Required").max(200),
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase, hyphenated"),
  service_type: z.enum(["roofing", "remodeling", "general_contracting", "construction", "pools"]),
  status: z.string().min(1),
});
type ClientEditForm = z.infer<typeof clientEditSchema>;

export function ClientDetail(props: Props) {
  const { client } = props;
  const router = useRouter();
  const archived = Boolean(client.deleted_at);
  const [editOpen, setEditOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);

  async function restore() {
    try {
      await restoreClient(client.id);
      toast.success("Client restored");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not restore client");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href="/clients" className="underline-offset-4 hover:underline">
            Clients
          </Link>{" "}
          / {client.name}
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{client.name}</h1>
            <StatusBadge status={archived ? "archived" : client.status} />
          </div>
          <div className="flex items-center gap-2">
            {archived ? (
              <Button variant="outline" onClick={restore}>
                <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                <span>Restore</span>
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  <span>Edit</span>
                </Button>
                <Button variant="destructive" onClick={() => setArchiveOpen(true)}>
                  <Archive className="h-4 w-4" aria-hidden="true" />
                  <span>Archive</span>
                </Button>
              </>
            )}
          </div>
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {client.slug} · {SERVICE_TYPE_LABEL[client.service_type] ?? client.service_type}
        </p>
      </div>

      <Tabs defaultValue="profile" className="w-full">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="services">Services &amp; Value Props</TabsTrigger>
          <TabsTrigger value="offers">Offers &amp; Constraints</TabsTrigger>
          <TabsTrigger value="assets">Assets</TabsTrigger>
          <TabsTrigger value="past_projects">Past Projects</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="pt-4">
          <ProfileSection clientId={client.id} profile={props.profile} />
        </TabsContent>

        <TabsContent value="services" className="space-y-8 pt-4">
          <ChildSection<ClientService, z.infer<typeof serviceSchema>>
            clientId={client.id}
            childKey="services"
            resourceName="service"
            title="Services"
            rows={props.services}
            schema={serviceSchema}
            emptyValues={{ service_name: "" }}
            toValues={(r) => ({ service_name: r.service_name })}
            renderFields={() => (
              <TextField name="service_name" label="Service name" placeholder="Roof replacement" />
            )}
            renderRow={(r) => <span className="text-foreground">{r.service_name}</span>}
          />
          <ChildSection<ClientValueProp, z.infer<typeof valuePropSchema>>
            clientId={client.id}
            childKey="value_props"
            resourceName="value prop"
            title="Value props"
            description="USPs and differentiators."
            rows={props.valueProps}
            schema={valuePropSchema}
            emptyValues={{ kind: "usp", prop_text: "" }}
            toValues={(r) => ({ kind: r.kind, prop_text: r.prop_text })}
            renderFields={() => (
              <>
                <SelectField
                  name="kind"
                  label="Kind"
                  options={[
                    { value: "usp", label: "USP" },
                    { value: "differentiator", label: "Differentiator" },
                  ]}
                />
                <TextareaField name="prop_text" label="Text" />
              </>
            )}
            renderRow={(r) => (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium uppercase text-muted-foreground">
                  {VALUE_PROP_KIND_LABEL[r.kind] ?? r.kind}
                </span>
                <span className="text-foreground">{r.prop_text}</span>
              </div>
            )}
          />
        </TabsContent>

        <TabsContent value="offers" className="space-y-8 pt-4">
          <ChildSection<ClientOffer, z.infer<typeof offerSchema>>
            clientId={client.id}
            childKey="offers"
            resourceName="offer"
            title="Offers"
            rows={props.offers}
            schema={offerSchema}
            emptyValues={{ offer_text: "", active: "true" }}
            toValues={(r) => ({ offer_text: r.offer_text, active: r.active ? "true" : "false" })}
            toBody={(v) => ({ offer_text: v.offer_text, active: v.active === "true" })}
            renderFields={() => (
              <>
                <TextareaField name="offer_text" label="Offer" />
                <SelectField
                  name="active"
                  label="Active"
                  options={[
                    { value: "true", label: "Active" },
                    { value: "false", label: "Inactive" },
                  ]}
                />
              </>
            )}
            renderRow={(r) => (
              <div className="flex items-center gap-2">
                <StatusBadge status={r.active ? "active" : "inactive"} />
                <span className="text-foreground">{r.offer_text}</span>
              </div>
            )}
          />
          <ChildSection<ClientOfferConstraint, z.infer<typeof constraintSchema>>
            clientId={client.id}
            childKey="offer_constraints"
            resourceName="constraint"
            title="Do-not-say constraints"
            description="Rules that keep ad copy compliant and on-brand."
            rows={props.constraints}
            schema={constraintSchema}
            emptyValues={{ constraint_text: "" }}
            toValues={(r) => ({ constraint_text: r.constraint_text })}
            renderFields={() => <TextareaField name="constraint_text" label="Constraint" />}
            renderRow={(r) => <span className="text-foreground">{r.constraint_text}</span>}
          />
        </TabsContent>

        <TabsContent value="assets" className="pt-4">
          <ChildSection<ClientAsset, z.infer<typeof assetSchema>>
            clientId={client.id}
            childKey="assets"
            resourceName="asset"
            title="Assets"
            description="Logos, banners, reviews, photos, and existing creatives."
            rows={props.assets}
            schema={assetSchema}
            emptyValues={{ kind: "logo", source: "drive", ref: "", label: "", formats: "" }}
            toValues={(r) => ({
              kind: r.kind,
              source: r.source,
              ref: r.ref,
              label: r.label ?? "",
              formats: r.formats ?? "",
            })}
            toBody={(v) => ({
              kind: v.kind,
              source: v.source,
              ref: v.ref,
              label: v.label?.trim() ? v.label.trim() : null,
              formats: v.formats?.trim() ? v.formats.trim() : null,
            })}
            renderFields={() => (
              <>
                <SelectField name="kind" label="Kind" options={ASSET_KIND_OPTIONS} />
                <SelectField name="source" label="Source" options={ASSET_SOURCE_OPTIONS} />
                <TextField name="ref" label="Reference" placeholder="drive id / url / filename" />
                <TextField name="label" label="Label" />
                <TextField name="formats" label="Formats" placeholder="1x1, 9x16" />
              </>
            )}
            renderRow={(r) => (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium uppercase text-muted-foreground">
                  {r.kind} · {r.source}
                </span>
                <span className="break-all text-foreground">{r.label || r.ref}</span>
              </div>
            )}
          />
        </TabsContent>

        <TabsContent value="past_projects" className="pt-4">
          <ChildSection<ClientPastProject, z.infer<typeof pastProjectSchema>>
            clientId={client.id}
            childKey="past_projects"
            resourceName="past project"
            title="Past projects"
            rows={props.pastProjects}
            schema={pastProjectSchema}
            emptyValues={{ url: "" }}
            toValues={(r) => ({ url: r.url })}
            renderFields={() => (
              <TextField name="url" label="Project URL" type="url" placeholder="https://..." />
            )}
            renderRow={(r) => (
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="break-all text-foreground underline-offset-4 hover:underline"
              >
                {r.url}
              </a>
            )}
          />
        </TabsContent>

        <TabsContent value="integrations" className="pt-4">
          <IntegrationsSection clientId={client.id} integrations={props.integrations} />
        </TabsContent>

        <TabsContent value="activity" className="pt-4">
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">Activity</h2>
            {props.activity.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                No activity yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {props.activity.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm"
                  >
                    <span className="font-mono text-foreground">{e.kind}</span>
                    <span className="text-muted-foreground">{formatDateTime(e.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </TabsContent>
      </Tabs>

      <CrudDialog<ClientEditForm>
        open={editOpen}
        onOpenChange={setEditOpen}
        title="Edit client"
        schema={clientEditSchema}
        defaultValues={{
          name: client.name,
          slug: client.slug,
          service_type: client.service_type,
          status: client.status,
        }}
        successMessage="Client updated"
        onSubmit={async (values) => {
          await updateClient(client.id, values);
        }}
        onSuccess={() => router.refresh()}
      >
        <TextField<ClientEditForm> name="name" label="Name" />
        <TextField<ClientEditForm> name="slug" label="Slug" />
        <SelectField<ClientEditForm>
          name="service_type"
          label="Service type"
          options={SERVICE_TYPE_OPTIONS}
        />
        <SelectField<ClientEditForm> name="status" label="Status" options={CLIENT_STATUS_OPTIONS} />
      </CrudDialog>

      <ConfirmArchive
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        resourceName="client"
        onConfirm={async () => {
          await archiveClient(client.id);
        }}
        onSuccess={() => router.refresh()}
      />
    </main>
  );
}
