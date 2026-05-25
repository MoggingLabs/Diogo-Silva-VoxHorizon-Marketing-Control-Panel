import { makeDeleteHandler, makePatchHandler } from "@/lib/clients/child-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH  /api/clients/:id/offer_constraints/:childId  — edit
 * DELETE /api/clients/:id/offer_constraints/:childId  — soft-archive
 */
export const PATCH = makePatchHandler("offer_constraints");
export const DELETE = makeDeleteHandler("offer_constraints");
