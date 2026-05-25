import { makeRestoreHandler } from "@/lib/clients/child-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/clients/:id/past_projects/:childId/restore — clear deleted_at. */
export const POST = makeRestoreHandler("past_projects");
