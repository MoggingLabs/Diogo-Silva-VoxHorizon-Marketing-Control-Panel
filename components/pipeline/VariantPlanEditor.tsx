"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createVariantPlanCell,
  deleteVariantPlanCell,
  updateVariantPlanCell,
  upsertVariantPlan,
  type VariantPlanCell,
  type VariantTestVariable,
} from "@/lib/variant-plan/client";

/**
 * A/B variant-plan editor (E5.2 / #596).
 *
 * Lets the operator author the plan in the variant_plan stage: pick the test
 * variable + hypothesis, then add / edit / remove cells (creative + copy
 * variant + label). The approve/reject DECISION stays in `StageVariantPlan` and
 * its decision route — this editor only crafts the draft. An approved plan is
 * locked server-side (409), so editing is for `draft` / `rejected` plans.
 */

const NONE = "__none__";

export type EditorCreative = { id: string; concept: string | null };
export type EditorCopyVariant = {
  id: string;
  creative_id: string;
  headline: string | null;
  variant_index: number;
};

export type VariantPlanEditorProps = {
  pipelineId: string;
  /** Whether a plan row already exists (controls create-vs-update copy). */
  planExists: boolean;
  /** Plan is approved -> locked: render read-only with a hint. */
  locked?: boolean;
  testVariable: VariantTestVariable | null;
  hypothesis: string | null;
  initialCells: VariantPlanCell[];
  creatives: EditorCreative[];
  copyVariants: EditorCopyVariant[];
};

export function VariantPlanEditor({
  pipelineId,
  planExists,
  locked = false,
  testVariable,
  hypothesis,
  initialCells,
  creatives,
  copyVariants,
}: VariantPlanEditorProps) {
  const router = useRouter();
  const [variable, setVariable] = React.useState<VariantTestVariable>(testVariable ?? "creative");
  const [hyp, setHyp] = React.useState(hypothesis ?? "");
  const [savingPlan, setSavingPlan] = React.useState(false);
  const [addingCell, setAddingCell] = React.useState(false);
  // Cells held in local state so edits feel instant; the server is the source
  // of truth and we router.refresh() to reconcile after each mutation.
  const [cells, setCells] = React.useState<VariantPlanCell[]>(initialCells);
  const [busyCellId, setBusyCellId] = React.useState<string | null>(null);

  React.useEffect(() => setCells(initialCells), [initialCells]);

  const creativeLabel = React.useCallback(
    (id: string | null) => {
      if (!id) return "—";
      const c = creatives.find((x) => x.id === id);
      return c ? (c.concept ?? id.slice(0, 8)) : id.slice(0, 8);
    },
    [creatives],
  );

  const savePlan = async () => {
    setSavingPlan(true);
    try {
      await upsertVariantPlan(pipelineId, { test_variable: variable, hypothesis: hyp || null });
      toast.success(planExists ? "Plan updated" : "Plan created");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the plan");
    } finally {
      setSavingPlan(false);
    }
  };

  const addCell = async () => {
    setAddingCell(true);
    try {
      const cell = await createVariantPlanCell(pipelineId, {});
      setCells((prev) => [...prev, cell]);
      toast.success("Cell added");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add a cell");
    } finally {
      setAddingCell(false);
    }
  };

  const patchCell = async (cellId: string, patch: Parameters<typeof updateVariantPlanCell>[2]) => {
    setBusyCellId(cellId);
    try {
      const updated = await updateVariantPlanCell(pipelineId, cellId, patch);
      setCells((prev) => prev.map((c) => (c.id === cellId ? updated : c)));
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the cell");
    } finally {
      setBusyCellId(null);
    }
  };

  const removeCell = async (cellId: string) => {
    setBusyCellId(cellId);
    try {
      await deleteVariantPlanCell(pipelineId, cellId);
      setCells((prev) => prev.filter((c) => c.id !== cellId));
      toast.success("Cell removed");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the cell");
    } finally {
      setBusyCellId(null);
    }
  };

  return (
    <section
      data-testid="variant-plan-editor"
      className="space-y-4 rounded-lg border border-border bg-card px-4 py-4 sm:px-5 sm:py-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight">A/B plan editor</h3>
        {locked ? (
          <span className="text-xs text-muted-foreground">
            Approved plans are locked. Reject to re-open for editing.
          </span>
        ) : null}
      </div>

      {/* Plan fields */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="vp-variable">Test variable</Label>
          <Select
            value={variable}
            onValueChange={(v) => setVariable(v as VariantTestVariable)}
            disabled={locked}
          >
            <SelectTrigger id="vp-variable" aria-label="Test variable">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="creative">Creative</SelectItem>
              <SelectItem value="copy">Copy</SelectItem>
              <SelectItem value="audience">Audience</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="vp-hypothesis">Hypothesis</Label>
          <Input
            id="vp-hypothesis"
            value={hyp}
            onChange={(e) => setHyp(e.target.value)}
            placeholder="e.g. Hook A beats Hook B on CPL"
            disabled={locked}
          />
        </div>
      </div>

      {!locked ? (
        <div>
          <Button type="button" size="sm" onClick={savePlan} disabled={savingPlan}>
            {savingPlan ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="h-4 w-4" aria-hidden="true" />
            )}
            {planExists ? "Save plan" : "Create plan"}
          </Button>
        </div>
      ) : null}

      {/* Cells */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Test cells
          </h4>
          {!locked && planExists ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addCell}
              disabled={addingCell}
            >
              {addingCell ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="h-4 w-4" aria-hidden="true" />
              )}
              Add cell
            </Button>
          ) : null}
        </div>

        {!planExists ? (
          <p className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
            Create the plan first, then add A/B test cells.
          </p>
        ) : cells.length === 0 ? (
          <p
            data-testid="variant-editor-empty"
            className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground"
          >
            No cells yet. Add one to start building the matrix.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="variant-editor-cells">
            {cells.map((cell) => {
              const copyForCreative = cell.creative_id
                ? copyVariants.filter((cv) => cv.creative_id === cell.creative_id)
                : copyVariants;
              const busy = busyCellId === cell.id;
              return (
                <li
                  key={cell.id}
                  data-testid={`editor-cell-${cell.cell_index}`}
                  className="grid gap-2 rounded-md border border-border px-3 py-3 sm:grid-cols-[auto_1fr_1fr_1fr_auto] sm:items-end"
                >
                  <div className="space-y-1.5">
                    <Label className="text-xs">Label</Label>
                    <Input
                      defaultValue={cell.label ?? ""}
                      placeholder="A"
                      aria-label={`Cell ${cell.cell_index} label`}
                      className="h-9 w-20"
                      disabled={locked || busy}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== (cell.label ?? "")) void patchCell(cell.id, { label: v || null });
                      }}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Creative</Label>
                    <Select
                      value={cell.creative_id ?? NONE}
                      disabled={locked || busy}
                      onValueChange={(v) =>
                        void patchCell(cell.id, { creative_id: v === NONE ? null : v })
                      }
                    >
                      <SelectTrigger
                        className="h-9"
                        aria-label={`Cell ${cell.cell_index} creative`}
                      >
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>None</SelectItem>
                        {creatives.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.concept ?? c.id.slice(0, 8)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Copy variant</Label>
                    <Select
                      value={cell.copy_variant_id ?? NONE}
                      disabled={locked || busy}
                      onValueChange={(v) =>
                        void patchCell(cell.id, { copy_variant_id: v === NONE ? null : v })
                      }
                    >
                      <SelectTrigger className="h-9" aria-label={`Cell ${cell.cell_index} copy`}>
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>None</SelectItem>
                        {copyForCreative.map((cv) => (
                          <SelectItem key={cv.id} value={cv.id}>
                            {cv.headline ?? `Variant ${cv.variant_index}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="text-xs text-muted-foreground sm:self-center">
                    <span className="block sm:hidden">Cell {cell.cell_index}</span>
                    <span className="hidden sm:block">{creativeLabel(cell.creative_id)}</span>
                  </div>

                  {!locked ? (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-9 w-9 text-destructive hover:text-destructive"
                      disabled={busy}
                      aria-label={`Remove cell ${cell.cell_index}`}
                      onClick={() => void removeCell(cell.id)}
                    >
                      {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      )}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
