import { NextResponse, type NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/creatives/video?brief_id=<uuid>  OR  ?ids=<id,id,...>
 *
 * Lists video creatives either for a brief (ideation grid / done gallery) or
 * by an explicit id set (review picks). Replaces the client-side
 * `supabase.from("video_creatives").select(...)` reads in `StageIdeation` /
 * `StageReview` / `StageDone` that stopped returning rows under RLS deny-all.
 * Reads via the service-role client; gated by Caddy basic auth.
 *
 * When `with_outline=1` is passed alongside `ids`, the response also includes
 * `outlines` — a map of `brief_id → script_outline` — so the review picks grid
 * can render the hook excerpt without a second client round-trip.
 *
 * Returns: `{ creatives: VideoCreative[], outlines?: Record<string, unknown> }`.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const briefId = url.searchParams.get("brief_id");
  const idsParam = url.searchParams.get("ids");
  const withOutline = url.searchParams.get("with_outline") === "1";

  const supabase = createAdminClient();

  if (briefId) {
    const { data, error } = await supabase
      .from("video_creatives")
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
      return NextResponse.json({ creatives: [], ...(withOutline ? { outlines: {} } : {}) });
    }
    const { data, error } = await supabase.from("video_creatives").select("*").in("id", ids);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const creatives = data ?? [];

    if (!withOutline) {
      return NextResponse.json({ creatives });
    }

    const briefIds = Array.from(
      new Set(
        creatives.map((c) => c.brief_id).filter((id): id is string => typeof id === "string"),
      ),
    );
    const outlines: Record<string, unknown> = {};
    if (briefIds.length > 0) {
      const { data: briefs, error: briefErr } = await supabase
        .from("video_briefs")
        .select("id, script_outline")
        .in("id", briefIds);
      if (briefErr) {
        return NextResponse.json({ error: briefErr.message }, { status: 500 });
      }
      for (const b of briefs ?? []) {
        outlines[b.id] = (b as { script_outline?: unknown }).script_outline ?? null;
      }
    }
    return NextResponse.json({ creatives, outlines });
  }

  return NextResponse.json({ error: "missing_brief_id_or_ids" }, { status: 400 });
}
