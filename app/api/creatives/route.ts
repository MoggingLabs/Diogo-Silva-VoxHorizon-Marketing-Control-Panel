import { NextResponse, type NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/creatives?brief_id=<uuid>  OR  ?ids=<id,id,...>
 *
 * Lists image creatives either for a brief (ideation grid) or by an explicit
 * id set (review picks). Replaces the client-side
 * `supabase.from("creatives").select(...)` reads in `StageIdeation` /
 * `StageReview` that stopped returning rows under RLS deny-all. Reads via the
 * service-role client; gated by Caddy basic auth.
 *
 * `ids` preserves no particular order (callers re-order client-side); rows are
 * returned oldest-first when querying by brief.
 *
 * Returns: `{ creatives: Creative[] }`.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const briefId = url.searchParams.get("brief_id");
  const idsParam = url.searchParams.get("ids");

  const supabase = createAdminClient();

  if (briefId) {
    const { data, error } = await supabase
      .from("creatives")
      .select("*")
      .eq("brief_id", briefId)
      .order("created_at", { ascending: true });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ creatives: data ?? [] });
  }

  if (idsParam) {
    const ids = idsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return NextResponse.json({ creatives: [] });
    }
    const { data, error } = await supabase.from("creatives").select("*").in("id", ids);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ creatives: data ?? [] });
  }

  return NextResponse.json({ error: "missing_brief_id_or_ids" }, { status: 400 });
}
