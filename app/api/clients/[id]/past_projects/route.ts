import { makeCreateHandler, makeListHandler } from "@/lib/clients/child-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/clients/:id/past_projects  — list (filter/sort/paginate, active only)
 * POST /api/clients/:id/past_projects  — create
 *
 * Thin binding to the shared child-route factory (lib/clients/child-routes).
 */
export const GET = makeListHandler("past_projects");
export const POST = makeCreateHandler("past_projects");
