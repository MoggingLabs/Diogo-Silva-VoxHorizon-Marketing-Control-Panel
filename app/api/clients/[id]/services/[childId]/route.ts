import { makeDeleteHandler, makePatchHandler } from "@/lib/clients/child-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH  /api/clients/:id/services/:childId  — edit
 * DELETE /api/clients/:id/services/:childId  — soft-archive
 */
export const PATCH = makePatchHandler("services");
export const DELETE = makeDeleteHandler("services");
