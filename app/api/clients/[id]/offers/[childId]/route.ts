import { makeDeleteHandler, makePatchHandler } from "@/lib/clients/child-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH  /api/clients/:id/offers/:childId  — edit
 * DELETE /api/clients/:id/offers/:childId  — soft-archive
 */
export const PATCH = makePatchHandler("offers");
export const DELETE = makeDeleteHandler("offers");
