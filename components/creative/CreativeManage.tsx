"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useFormContext } from "react-hook-form";
import { Archive, ArchiveRestore, ExternalLink, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { ConfirmArchive } from "@/components/shared/ConfirmArchive";
import { CrudDrawer } from "@/components/shared/CrudDrawer";
import { DecisionButtons } from "@/components/creative/DecisionButtons";
import { IterationThread } from "@/components/creative/IterationThread";
import { ManagedGatePanels } from "@/components/creative/ManagedGatePanels";
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
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Textarea } from "@/components/ui/textarea";
import { fetchCreativeIterations } from "@/lib/realtime/client-data";
import {
  STATUS_LABEL,
  type Creative,
  type CreativeIteration,
  type CreativeStatusT,
  type RatioT,
} from "@/lib/creatives";
import { archiveCreative, restoreCreative, updateImageCreative } from "@/lib/creatives-client";

type Brief = {
  id: string;
  brief_id_human: string;
  status: string;
  client_id: string | null;
} | null;

type Row = Record<string, unknown> & { id: string };

export type CreativeManageProps = {
  creative: Creative;
  brief: Brief;
  signedUrl: string | null;
  copyVariants: Row[];
  qa: Row[];
  spec: Row[];
  compliance: Row[];
  stageState: Row[];
};

const EditSchema = z.object({
  concept: z.string().max(2000),
  offer_text: z.string().max(2000),
  asset_name: z.string().max(500),
  ratio: z.enum(["", "1x1", "9x16", "16x9"]),
});
type EditValues = z.infer<typeof EditSchema>;

/** Sentinel for the "no ratio" Select option (Radix forbids value=""). */
const RATIO_NONE = "__none__";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Per-creative manage surface for an image creative (E4.2 / #594).
 *
 * Composes the existing review building blocks into one page: a metadata edit
 * drawer (PATCH the safe fields), the approve/reject DecisionButtons (the
 * existing decision route — the ONLY way status changes), the IterationThread
 * (existing iterations route), the copy variants, and read-only gate panels
 * (QA / spec / compliance / stage state) that mutate only through their
 * pipeline-scoped decision/override routes — surfaced read-only with a link to
 * the pipeline review surface. Soft-delete + restore are wired to the CRUD
 * routes.
 */
export function CreativeManage({
  creative,
  brief,
  signedUrl,
  copyVariants,
  qa,
  spec,
  compliance,
  stageState,
}: CreativeManageProps) {
  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmArchive, setConfirmArchive] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);

  const [iterations, setIterations] = React.useState<CreativeIteration[]>([]);
  const [iterationsError, setIterationsError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void fetchCreativeIterations<CreativeIteration>(creative.id)
      .then((data) => {
        if (!cancelled) setIterations(data);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setIterationsError(e instanceof Error ? e.message : "Failed to load iterations");
      });
    return () => {
      cancelled = true;
    };
  }, [creative.id]);

  const status = creative.status as CreativeStatusT;
  const archived = creative.deleted_at != null;
  const pipelineHref = creative.pipeline_id ? `/pipeline/${creative.pipeline_id}` : null;

  async function onSubmitEdit(values: EditValues) {
    await updateImageCreative(creative.id, {
      concept: values.concept.trim() === "" ? null : values.concept.trim(),
      offer_text: values.offer_text.trim() === "" ? null : values.offer_text.trim(),
      asset_name: values.asset_name.trim() === "" ? null : values.asset_name.trim(),
      ratio: values.ratio === "" ? null : (values.ratio as RatioT),
    });
    router.refresh();
  }

  async function onArchive() {
    await archiveCreative("image", creative.id);
    router.refresh();
  }

  async function onRestore() {
    setRestoring(true);
    try {
      await restoreCreative("image", creative.id);
      toast.success("Creative restored");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not restore creative");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <main className="container mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <header className="space-y-3">
        <nav className="text-sm text-muted-foreground" aria-label="Breadcrumb">
          <Link href="/creatives" className="underline-offset-4 hover:underline">
            Creatives
          </Link>{" "}
          / <span>Manage</span>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {creative.concept?.trim() || "Untitled concept"}
          </h1>
          <StatusBadge status={status} />
          {archived ? <StatusBadge status="archived" /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setEditOpen(true)}
            disabled={archived}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Edit metadata
          </Button>
          {archived ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={restoring}
              onClick={() => void onRestore()}
            >
              {restoring ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Restore
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={() => setConfirmArchive(true)}
            >
              <Archive className="h-3.5 w-3.5" aria-hidden="true" />
              Archive
            </Button>
          )}
          {pipelineHref ? (
            <Button asChild variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
              <Link href={pipelineHref as Route}>
                Review in pipeline
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-6">
          <Section title="Preview">
            {signedUrl ? (
              <a
                href={signedUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="block overflow-hidden rounded-lg border bg-muted/40"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- signed Supabase URL */}
                <img
                  src={signedUrl}
                  alt={creative.concept ?? "Creative preview"}
                  className="max-h-[420px] w-full object-contain"
                />
              </a>
            ) : (
              <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-10 text-center text-xs text-muted-foreground">
                No render yet.
              </div>
            )}
          </Section>

          <Section title="Decision">
            {status === "draft" ? (
              <DecisionButtons creativeId={creative.id} />
            ) : (
              <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {creative.approved_at
                  ? `Decided ${fmt(creative.approved_at)} · ${STATUS_LABEL[status]}`
                  : `Status: ${STATUS_LABEL[status]}. No further decision needed here.`}
              </p>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">
              Status changes go through the decision route, never a raw edit.
            </p>
          </Section>

          <Section title={`Copy variants (${copyVariants.length})`}>
            {copyVariants.length === 0 ? (
              <Empty>No copy variants for this creative yet.</Empty>
            ) : (
              <ul className="space-y-2">
                {copyVariants.map((cv) => (
                  <li key={cv.id} className="rounded-md border bg-card px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium capitalize">{String(cv.platform ?? "—")}</span>
                      {cv.placement ? (
                        <span className="text-xs text-muted-foreground">
                          {String(cv.placement)}
                        </span>
                      ) : null}
                      {cv.status ? <StatusBadge status={String(cv.status)} /> : null}
                    </div>
                    {cv.headline ? (
                      <p className="mt-1 text-sm font-medium">{String(cv.headline)}</p>
                    ) : null}
                    {cv.body ? (
                      <p className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">
                        {String(cv.body)}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Iterations">
            {iterationsError ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {iterationsError}
              </p>
            ) : (
              <IterationThread creativeId={creative.id} initialIterations={iterations} />
            )}
          </Section>
        </div>

        <aside className="flex flex-col gap-6">
          <Section title="Metadata">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <Field label="Brief">
                {brief ? (
                  <Link
                    href={`/creatives/${brief.id}` as Route}
                    className="font-mono underline-offset-4 hover:underline"
                  >
                    {brief.brief_id_human}
                  </Link>
                ) : (
                  "—"
                )}
              </Field>
              <Field label="Offer">{creative.offer_text ?? "—"}</Field>
              <Field label="Ratio" mono>
                {creative.ratio ?? "—"}
              </Field>
              <Field label="Version" mono>
                {creative.version}
              </Field>
              <Field label="Asset name">{creative.asset_name ?? "—"}</Field>
              <Field label="Created">{fmt(creative.created_at)}</Field>
              <Field label="Drive">
                {creative.file_path_drive ? (
                  <a
                    href={creative.file_path_drive}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                  >
                    Open <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ) : (
                  "—"
                )}
              </Field>
            </dl>
          </Section>

          <Section title="QA / Spec / Compliance">
            <ManagedGatePanels
              creativeId={creative.id}
              pipelineId={creative.pipeline_id}
              surface="image"
              qa={qa}
              spec={spec}
              compliance={compliance}
            />
            <GatePanel label="Stage state">
              {stageState.length === 0 ? (
                <Empty>No gate state.</Empty>
              ) : (
                stageState.map((r) => (
                  <GateRow
                    key={r.id}
                    status={String(r.status ?? "unknown")}
                    primary={String(r.stage ?? "—")}
                  />
                ))
              )}
            </GatePanel>
            <p className="text-[11px] text-muted-foreground">
              Gate transitions (stage state) flow through the decision routes only.
              {pipelineHref ? (
                <>
                  {" "}
                  <Link href={pipelineHref as Route} className="underline underline-offset-4">
                    Open the pipeline review
                  </Link>{" "}
                  for the full gate flow.
                </>
              ) : null}
            </p>
          </Section>
        </aside>
      </div>

      <CrudDrawer<EditValues>
        open={editOpen}
        onOpenChange={setEditOpen}
        title="Edit creative metadata"
        description="Edit the descriptive fields. Status is set via the decision actions, not here."
        schema={EditSchema}
        defaultValues={{
          concept: creative.concept ?? "",
          offer_text: creative.offer_text ?? "",
          asset_name: creative.asset_name ?? "",
          ratio: (creative.ratio ?? "") as EditValues["ratio"],
        }}
        onSubmit={onSubmitEdit}
        successMessage="Creative updated"
      >
        <EditFields />
      </CrudDrawer>

      <ConfirmArchive
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        resourceName="creative"
        onConfirm={onArchive}
        onSuccess={() => router.refresh()}
        successMessage="Creative archived"
      />
    </main>
  );
}

function EditFields() {
  const { register, setValue, watch } = useFormContext<EditValues>();
  const ratio = watch("ratio");
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="concept">Concept</Label>
        <Textarea id="concept" rows={3} {...register("concept")} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="offer_text">Offer text</Label>
        <Textarea id="offer_text" rows={2} {...register("offer_text")} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="asset_name">Asset name</Label>
        <Input id="asset_name" {...register("asset_name")} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ratio">Ratio</Label>
        {/* Radix forbids an empty-string item value, so map "" <-> a sentinel. */}
        <Select
          value={ratio === "" ? RATIO_NONE : ratio}
          onValueChange={(v) =>
            setValue("ratio", (v === RATIO_NONE ? "" : v) as EditValues["ratio"])
          }
        >
          <SelectTrigger id="ratio">
            <SelectValue placeholder="No ratio" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={RATIO_NONE}>No ratio</SelectItem>
            <SelectItem value="1x1">1x1</SelectItem>
            <SelectItem value="9x16">9x16</SelectItem>
            <SelectItem value="16x9">16x9</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd
        className={mono ? "break-words font-mono text-xs" : "break-words text-xs text-foreground"}
      >
        {children}
      </dd>
    </div>
  );
}

function GatePanel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium text-foreground">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function GateRow({ status, primary, note }: { status: string; primary: string; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-card px-2 py-1 text-xs">
      <span className="truncate">{primary}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {note ? <span className="text-[10px] text-amber-600">{note}</span> : null}
        <StatusBadge status={status} />
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}
