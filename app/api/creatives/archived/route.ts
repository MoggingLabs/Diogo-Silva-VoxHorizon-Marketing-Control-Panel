import { ok, serverError } from "@/lib/crud";
import { buildCreativeRows } from "@/lib/creatives-rows";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/creatives/archived
 *
 * Returns the unified ARCHIVED creative rows (image + video) for the grid's
 * Archived view (M4 / #593). Mirrors the active set the `/creatives` page
 * renders server-side, signing image thumbnails + resolving brief labels via
 * the shared `buildCreativeRows` helper so the row shape is identical.
 *
 * Response: `{ rows: CreativeRow[] }`.
 */
export async function GET() {
  const admin = createAdminClient();
  const { rows, error } = await buildCreativeRows(admin, { archived: true });
  if (error) return serverError(error);
  return ok({ rows });
}
