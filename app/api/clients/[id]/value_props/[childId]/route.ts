import { makeDeleteHandler, makePatchHandler } from "@/lib/clients/child-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH  /api/clients/:id/value_props/:childId  — edit
 * DELETE /api/clients/:id/value_props/:childId  — soft-archive
 */
export const PATCH = makePatchHandler("value_props");
export const DELETE = makeDeleteHandler("value_props");
