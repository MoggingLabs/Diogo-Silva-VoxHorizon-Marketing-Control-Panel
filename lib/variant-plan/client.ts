/**
 * Browser-side fetch wrappers for the variant-plan editor (E5.2 / #596).
 *
 * Used by the VariantPlanEditor client component to author the A/B plan before
 * the approve/reject decision (which stays in the variant-plan/decision route).
 * Relative URLs; throws the inline error body for the caller to toast.
 */

export type VariantPlanCell = {
  id: string;
  variant_plan_id: string;
  cell_index: number;
  creative_id: string | null;
  copy_variant_id: string | null;
  /** Free-form targeting jsonb; the editor does not deep-edit it. */
  audience: unknown;
  label: string | null;
};

export type VariantPlan = {
  id: string;
  pipeline_id: string;
  test_variable: string;
  hypothesis: string | null;
  status: string;
};

export type VariantTestVariable = "creative" | "copy" | "audience";

async function throwOnError(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  let message = body.slice(0, 300) || res.statusText;
  try {
    const parsed = JSON.parse(body) as { error?: string; reason?: string };
    if (parsed.error) message = parsed.reason ? `${parsed.error}: ${parsed.reason}` : parsed.error;
  } catch {
    // keep the raw text
  }
  throw new Error(`${label} failed (${res.status}): ${message}`);
}

const planBase = (pipelineId: string) =>
  `/api/pipelines/${encodeURIComponent(pipelineId)}/variant-plan`;

/** Upsert the plan's draft fields, creating it if absent. */
export async function upsertVariantPlan(
  pipelineId: string,
  body: { test_variable: VariantTestVariable; hypothesis?: string | null },
): Promise<VariantPlan> {
  const res = await fetch(planBase(pipelineId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  await throwOnError(res, `PUT ${planBase(pipelineId)}`);
  const json = (await res.json()) as { plan: VariantPlan };
  return json.plan;
}

/** Create one cell. Returns the created cell. */
export async function createVariantPlanCell(
  pipelineId: string,
  body: {
    creative_id?: string | null;
    copy_variant_id?: string | null;
    audience?: Record<string, unknown> | null;
    label?: string | null;
  },
): Promise<VariantPlanCell> {
  const res = await fetch(`${planBase(pipelineId)}/cells`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  await throwOnError(res, `POST ${planBase(pipelineId)}/cells`);
  const json = (await res.json()) as { cell: VariantPlanCell };
  return json.cell;
}

/** Edit one cell. */
export async function updateVariantPlanCell(
  pipelineId: string,
  cellId: string,
  body: {
    creative_id?: string | null;
    copy_variant_id?: string | null;
    audience?: Record<string, unknown> | null;
    label?: string | null;
  },
): Promise<VariantPlanCell> {
  const res = await fetch(`${planBase(pipelineId)}/cells/${encodeURIComponent(cellId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  await throwOnError(res, `PATCH ${planBase(pipelineId)}/cells/${cellId}`);
  const json = (await res.json()) as { cell: VariantPlanCell };
  return json.cell;
}

/** Remove one cell (hard-delete — pure child config row). */
export async function deleteVariantPlanCell(pipelineId: string, cellId: string): Promise<void> {
  const res = await fetch(`${planBase(pipelineId)}/cells/${encodeURIComponent(cellId)}`, {
    method: "DELETE",
    cache: "no-store",
  });
  await throwOnError(res, `DELETE ${planBase(pipelineId)}/cells/${cellId}`);
}
