import { makeCreateHandler, makeListHandler } from "@/lib/clients/child-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/clients/:id/value_props  — list (filter/sort/paginate, active only)
 * POST /api/clients/:id/value_props  — create
 *
 * Thin binding to the shared child-route factory (lib/clients/child-routes).
 */
export const GET = makeListHandler("value_props");
export const POST = makeCreateHandler("value_props");
