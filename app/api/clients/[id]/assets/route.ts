import { makeCreateHandler, makeListHandler } from "@/lib/clients/child-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/clients/:id/assets  — list (filter/sort/paginate, active only)
 * POST /api/clients/:id/assets  — create
 *
 * Thin binding to the shared child-route factory (lib/clients/child-routes).
 */
export const GET = makeListHandler("assets");
export const POST = makeCreateHandler("assets");
