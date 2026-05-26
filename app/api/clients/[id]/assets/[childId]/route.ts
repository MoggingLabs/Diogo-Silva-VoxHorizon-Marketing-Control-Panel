import { makeDeleteHandler, makePatchHandler } from "@/lib/clients/child-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH  /api/clients/:id/assets/:childId  — edit
 * DELETE /api/clients/:id/assets/:childId  — soft-archive
 */
export const PATCH = makePatchHandler("assets");
export const DELETE = makeDeleteHandler("assets");
