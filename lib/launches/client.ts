/**
 * Browser-side fetch wrappers for the unified Launches surface (E5.1 / #595).
 *
 * These run in client components (the LaunchesManager + detail actions), so
 * they use relative URLs and throw the inline error body on a non-2xx response
 * for the caller to toast. One ``format`` arg routes to the image vs video
 * endpoints, which are structurally identical (parity dual-tables). The launch
 * DECISION is deliberately NOT here — it flows through the existing
 * ApprovalGate / VideoLaunchApprovalGate components against the decision route
 * which re-derives the gate server-side.
 */

export type LaunchFormat = "image" | "video";

/** Row shape returned by the launch list endpoints (both formats). */
export type LaunchListRow = {
  id: string;
  brief_id: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decided_notes: string | null;
  payload: unknown;
  deleted_at: string | null;
};

function basePath(format: LaunchFormat): string {
  return format === "video" ? "/api/launches/video" : "/api/launches";
}

async function throwOnError(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  let message = body.slice(0, 300) || res.statusText;
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed.error) message = parsed.error;
  } catch {
    // keep the raw text
  }
  throw new Error(`${label} failed (${res.status}): ${message}`);
}

/** List launch packages for a format. ``archived`` lists the archived set. */
export async function listLaunches(
  format: LaunchFormat,
  opts: { archived?: boolean } = {},
): Promise<LaunchListRow[]> {
  const params = new URLSearchParams();
  if (opts.archived) params.set("archived", "true");
  const qs = params.toString();
  const res = await fetch(`${basePath(format)}${qs ? `?${qs}` : ""}`, { cache: "no-store" });
  await throwOnError(res, `GET ${basePath(format)}`);
  const json = (await res.json()) as { launches?: LaunchListRow[] };
  return json.launches ?? [];
}

/** Soft-archive one launch package. */
export async function archiveLaunch(format: LaunchFormat, id: string): Promise<void> {
  const res = await fetch(`${basePath(format)}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    cache: "no-store",
  });
  await throwOnError(res, `DELETE ${basePath(format)}/${id}`);
}

/** Restore one archived launch package. */
export async function restoreLaunch(format: LaunchFormat, id: string): Promise<void> {
  const res = await fetch(`${basePath(format)}/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    cache: "no-store",
  });
  await throwOnError(res, `POST ${basePath(format)}/${id}/restore`);
}

/** Update the operator annotation (decided_notes) on a launch package. */
export async function updateLaunch(
  format: LaunchFormat,
  id: string,
  patch: { decided_notes?: string | null },
): Promise<void> {
  const res = await fetch(`${basePath(format)}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(patch),
  });
  await throwOnError(res, `PATCH ${basePath(format)}/${id}`);
}
