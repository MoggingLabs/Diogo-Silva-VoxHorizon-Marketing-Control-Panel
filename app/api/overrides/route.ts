import { NextResponse, type NextRequest } from "next/server";

import { OverrideInput } from "@/lib/overrides";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types.gen";

type OverrideInsert = Database["public"]["Tables"]["overrides"]["Insert"];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/overrides
 *
 * Upsert an operator correction onto an arbitrary `(table_name, row_id,
 * field_name)` tuple. The source row is never touched — reads should
 * left-join `overrides` on the same key.
 *
 * Conflict target matches the unique constraint declared in
 * `db/migrations/0001_initial_schema.sql`. Repeated edits of the same
 * field replace the previous correction in place; `edited_at` defaults
 * to `now()` via the column default.
 *
 * Marked `edited_by = 'operator'` for now. Once auth is wired, this becomes
 * the actual user id pulled off the request (M3).
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = OverrideInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();
  const row: OverrideInsert = {
    table_name: parsed.data.table_name,
    row_id: parsed.data.row_id,
    field_name: parsed.data.field_name,
    corrected_value: parsed.data.corrected_value as Json,
    edited_by: "operator",
  };

  const { error } = await supabase
    .from("overrides")
    .upsert(row, { onConflict: "table_name,row_id,field_name" });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
