import { createClient } from "@/lib/supabase/server";
import { type Client } from "@/lib/clients/schemas";

import { ClientsTable } from "@/components/clients/ClientsTable";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Clients — VoxHorizon",
};

/**
 * Clients list (E2.4). Server component loads the rows via the service-role
 * client (RLS deny-all means the browser cannot read directly) and hands them
 * to the client `ClientsTable`, which owns sort/filter/search/paginate (client
 * mode), row edit/archive/restore, and bulk archive.
 *
 * Active clients are shown by default; the table's status filter can surface
 * archived ones. We load both (incl. soft-deleted) so the operator can find and
 * restore an archived client without a separate page.
 */
export default async function ClientsPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, slug, service_type, status, created_at, deleted_at")
    .order("created_at", { ascending: false })
    .limit(500);

  const clients = (data ?? []) as Client[];

  return <ClientsTable initialClients={clients} loadError={error?.message ?? null} />;
}
