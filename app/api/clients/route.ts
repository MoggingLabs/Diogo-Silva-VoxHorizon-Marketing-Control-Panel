import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/clients
 *
 * Lists active clients for the brief/pipeline configuration pickers. Replaces
 * the client-side `supabase.from("clients").select(...)` reads that stopped
 * returning rows once RLS deny-all blocked the anon key. Gated by Caddy basic
 * auth; reads via the service-role client (bypasses RLS).
 *
 * Returns: `{ clients: { id, name, slug, service_type }[] }` ordered by name.
 */
export async function GET() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, slug, service_type")
    .eq("status", "active")
    .order("name");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ clients: data ?? [] });
}
