import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/clients
 *
 * Lists clients for the brief/pipeline configuration pickers. Replaces the
 * client-side `supabase.from("clients").select(...)` reads that stopped
 * returning rows once RLS deny-all blocked the anon key. Gated by Caddy basic
 * auth; reads via the service-role client (bypasses RLS). Read-only.
 *
 * Returns: `{ clients: { id, name, slug, service_type, status }[] }` ordered
 * active-first then alphabetically by name. Active clients sort ahead of
 * inactive/archived ones so the common case (assigning a live client) is at
 * the top of the dropdown.
 */
export async function GET() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, slug, service_type, status")
    // active before everything else, then alphabetical within each group.
    .order("status", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // `status` is free-text (default 'active'); pull active rows to the front
  // explicitly rather than relying on the lexical order of arbitrary states.
  const rows = data ?? [];
  const clients = [...rows].sort((a, b) => {
    const aActive = a.status === "active" ? 0 : 1;
    const bActive = b.status === "active" ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.name.localeCompare(b.name);
  });

  return NextResponse.json({ clients });
}
