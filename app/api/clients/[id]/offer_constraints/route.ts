import { makeCreateHandler, makeListHandler } from "@/lib/clients/child-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/clients/:id/offer_constraints  — list (filter/sort/paginate, active only)
 * POST /api/clients/:id/offer_constraints  — create
 *
 * Thin binding to the shared child-route factory (lib/clients/child-routes).
 */
export const GET = makeListHandler("offer_constraints");
export const POST = makeCreateHandler("offer_constraints");
