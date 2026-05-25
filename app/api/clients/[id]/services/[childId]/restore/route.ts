import { makeRestoreHandler } from "@/lib/clients/child-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/clients/:id/services/:childId/restore — clear deleted_at. */
export const POST = makeRestoreHandler("services");
