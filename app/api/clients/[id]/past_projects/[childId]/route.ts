import { makeDeleteHandler, makePatchHandler } from "@/lib/clients/child-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH  /api/clients/:id/past_projects/:childId  — edit
 * DELETE /api/clients/:id/past_projects/:childId  — soft-archive
 */
export const PATCH = makePatchHandler("past_projects");
export const DELETE = makeDeleteHandler("past_projects");
