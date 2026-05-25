import { notFound } from "next/navigation";

import { maskIntegrations } from "@/lib/clients/integrations";
import { createClient } from "@/lib/supabase/server";
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

import { ClientDetail, type ClientActivity } from "@/components/clients/ClientDetail";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ id: string }> };

async function activeChildren<T>(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: string,
  clientId: string,
): Promise<T[]> {
  const { data } = await supabase
    .from(table as "client_services")
    .select("*")
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  return (data ?? []) as T[];
}

/**
 * Client detail (E2.4). Server component loads the client, its 1:1 profile,
 * every active config child, the integrations (secrets masked), and the recent
 * activity timeline, then hands them to the tabbed `ClientDetail` client view
 * which owns all child CRUD via CrudDrawer/Dialog + ConfirmArchive.
 */
export default async function ClientDetailPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", id).maybeSingle();

  if (!client) notFound();

  const { data: profile } = await supabase
    .from("client_profiles")
    .select("*")
    .eq("client_id", id)
    .is("deleted_at", null)
    .maybeSingle();

  const [services, valueProps, offers, constraints, assets, pastProjects, integrationsRaw] =
    await Promise.all([
      activeChildren<ClientService>(supabase, "client_services", id),
      activeChildren<ClientValueProp>(supabase, "client_value_props", id),
      activeChildren<ClientOffer>(supabase, "client_offers", id),
      activeChildren<ClientOfferConstraint>(supabase, "client_offer_constraints", id),
      activeChildren<ClientAsset>(supabase, "client_assets", id),
      activeChildren<ClientPastProject>(supabase, "client_past_projects", id),
      (async () => {
        const { data } = await supabase
          .from("client_integrations")
          .select("*")
          .eq("client_id", id)
          .is("deleted_at", null)
          .order("provider", { ascending: true });
        return (data ?? []) as ClientIntegration[];
      })(),
    ]);

  const { data: events } = await supabase
    .from("events")
    .select("id, kind, payload, created_at")
    .eq("ref_table", "clients")
    .eq("ref_id", id)
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <ClientDetail
      client={client as Client}
      profile={(profile ?? null) as ClientProfile | null}
      services={services}
      valueProps={valueProps}
      offers={offers}
      constraints={constraints}
      assets={assets}
      pastProjects={pastProjects}
      integrations={maskIntegrations(integrationsRaw)}
      activity={(events ?? []) as ClientActivity[]}
    />
  );
}
