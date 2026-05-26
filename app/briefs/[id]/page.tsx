import Link from "next/link";
import { notFound } from "next/navigation";

import { ApprovalGate } from "@/components/brief/ApprovalGate";
import { BriefTimeline } from "@/components/brief/BriefTimeline";
import { BriefDetailActions } from "@/components/briefs/BriefDetailActions";
import { readBriefPayload, type Brief, type BriefStatusT, type EventRow } from "@/lib/briefs";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<BriefStatusT, string> = {
  draft: "Draft",
  posted: "Posted",
  approved: "Approved",
  approved_with_changes: "Approved with changes",
  rejected: "Rejected",
};

const STATUS_BADGE: Record<BriefStatusT, string> = {
  draft: "bg-muted text-muted-foreground",
  posted: "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  approved: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  approved_with_changes: "bg-sky-100 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
  rejected: "bg-destructive/10 text-destructive",
};

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Brief ${id.slice(0, 8)} — VoxHorizon` };
}

export default async function BriefDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [briefRes, eventsRes] = await Promise.all([
    supabase.from("briefs").select("*, clients(name, slug)").eq("id", id).maybeSingle(),
    supabase
      .from("events")
      .select("*")
      .eq("ref_table", "briefs")
      .eq("ref_id", id)
      .order("created_at", { ascending: true })
      .limit(200),
  ]);

  if (briefRes.error) {
    throw new Error(briefRes.error.message);
  }
  if (!briefRes.data) notFound();

  const brief = briefRes.data as Brief & {
    deleted_at: string | null;
    clients: { name: string; slug: string } | null;
  };
  const events = (eventsRes.data ?? []) as EventRow[];
  const payload = readBriefPayload(brief);
  const archived = Boolean(brief.deleted_at);

  return (
    <main className="container mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">
          <Link href="/briefs" className="underline-offset-4 hover:underline">
            Briefs
          </Link>{" "}
          / <span className="break-all font-mono">{brief.brief_id_human}</span>
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {payload?.market ?? "Untitled brief"}
            </h1>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs ${STATUS_BADGE[brief.status]}`}
            >
              {STATUS_LABEL[brief.status]}
            </span>
            {archived ? (
              <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
                Archived
              </span>
            ) : null}
          </div>
          <BriefDetailActions brief={brief} archived={archived} />
        </div>
      </header>

      {archived ? (
        <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          This brief is archived. Restore it to edit or post it.
        </div>
      ) : null}

      <section className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        <Field label="Client" value={brief.clients?.name ?? "—"} />
        <Field label="Service" value={payload?.service ?? "—"} className="capitalize" />
        <Field
          label="Total budget"
          value={typeof payload?.budget === "number" ? `$${payload.budget.toLocaleString()}` : "—"}
        />
        <Field
          label="Daily budget"
          value={
            typeof payload?.budget_daily === "number"
              ? `$${payload.budget_daily.toLocaleString()}`
              : "—"
          }
        />
        <Field
          label="Image count"
          value={
            typeof payload?.creative_plan?.image_count === "number"
              ? String(payload.creative_plan.image_count)
              : "—"
          }
        />
        <Field
          label="Landing page"
          value={
            payload?.landing_page_url ? (
              <a
                href={payload.landing_page_url}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all underline-offset-4 hover:underline"
              >
                {payload.landing_page_url}
              </a>
            ) : (
              "—"
            )
          }
        />
        <Field label="Offer" value={payload?.offer_text ?? "—"} />
      </section>

      {payload?.targeting ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Targeting</h2>
          <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {typeof payload.targeting.radius_km === "number" ? (
              <Field label="Radius" value={`${payload.targeting.radius_km} km`} />
            ) : null}
            {Array.isArray(payload.targeting.zips) && payload.targeting.zips.length > 0 ? (
              <Field
                label="ZIPs"
                value={payload.targeting.zips.join(", ")}
                className="font-mono text-sm"
              />
            ) : null}
            {typeof payload.targeting.age_min === "number" ||
            typeof payload.targeting.age_max === "number" ? (
              <Field
                label="Age range"
                value={`${payload.targeting.age_min ?? "?"} – ${payload.targeting.age_max ?? "?"}`}
              />
            ) : null}
          </dl>
        </section>
      ) : null}

      {Array.isArray(payload?.angles) && payload.angles.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Angles</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {payload.angles.map((angle, i) => (
              <li key={i}>{angle}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {payload?.notes ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Notes</h2>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{payload.notes}</p>
        </section>
      ) : null}

      {brief.decided_at ? (
        <section className="space-y-1 rounded-md border bg-muted/30 px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Decision</p>
          <p className="text-sm">
            {STATUS_LABEL[brief.status]}
            {brief.decided_by ? (
              <span className="text-muted-foreground"> · by {brief.decided_by}</span>
            ) : null}
            {formatDate(brief.decided_at) ? (
              <span className="text-muted-foreground"> · {formatDate(brief.decided_at)}</span>
            ) : null}
          </p>
          {brief.decided_notes ? (
            <p className="mt-1 whitespace-pre-wrap text-sm">{brief.decided_notes}</p>
          ) : null}
        </section>
      ) : null}

      {brief.status === "posted" && !archived ? <ApprovalGate briefId={brief.id} /> : null}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Timeline</h2>
        <BriefTimeline briefId={brief.id} initialEvents={events} />
      </section>
    </main>
  );
}

function Field({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={className ?? "text-sm"}>{value}</dd>
    </div>
  );
}
