import { makeCreateHandler, makeListHandler } from "@/lib/clients/child-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/clients/:id/services  — list (filter/sort/paginate, active only)
 * POST /api/clients/:id/services  — create
 *
 * Thin binding to the shared child-route factory (lib/clients/child-routes).
 */
export const GET = makeListHandler("services");
export const POST = makeCreateHandler("services");
