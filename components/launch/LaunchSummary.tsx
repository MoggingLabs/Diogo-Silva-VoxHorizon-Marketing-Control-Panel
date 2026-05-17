import Image from "next/image";

import type { LaunchPayloadT } from "@/lib/launches";
import { readBriefPayload, type Brief } from "@/lib/briefs";
import type { Creative } from "@/lib/creatives";
import type { Database } from "@/lib/supabase/types.gen";

type CopyVariantRow = Database["public"]["Tables"]["copy_variants"]["Row"];

export interface LaunchSummaryProps {
  brief: Brief;
  creatives: Creative[];
  copyByCreativeId: Record<string, CopyVariantRow[]>;
  signedUrls: Record<string, string | null>;
  payload: LaunchPayloadT;
}

const RATIO_BADGE: Record<string, string> = {
  "1x1": "bg-zinc-100 text-zinc-700",
  "9x16": "bg-violet-100 text-violet-700",
  "16x9": "bg-sky-100 text-sky-700",
};

/**
 * Read-only summary of an image launch package.
 *
 * Renders:
 *   - Brief headline (market + service + budget).
 *   - Issues banner if the validator surfaced any.
 *   - One row per approved creative with:
 *       * thumbnail (signed URL)
 *       * ratio badge + concept + version
 *       * Drive link
 *       * stacked copy variants (headline / body / CTA)
 *
 * Mostly display — no interactive controls. The approval gate is shown
 * separately on the page when the launch is in ``posted`` status.
 */
export function LaunchSummary({
  brief,
  creatives,
  copyByCreativeId,
  signedUrls,
  payload,
}: LaunchSummaryProps) {
  const briefPayload = readBriefPayload(brief);

  return (
    <section className="space-y-6">
      <header className="space-y-2 rounded-md border bg-card p-4 shadow-sm">
        <h2 className="text-lg font-semibold">Brief overview</h2>
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Field label="Brief" value={<span className="font-mono">{brief.brief_id_human}</span>} />
          <Field label="Client" value={payload.client?.name ?? "—"} className="capitalize" />
          <Field label="Service" value={briefPayload?.service ?? "—"} className="capitalize" />
          <Field
            label="Total budget"
            value={
              typeof briefPayload?.budget === "number"
                ? `$${briefPayload.budget.toLocaleString()}`
                : "—"
            }
          />
          <Field label="Market" value={briefPayload?.market ?? "—"} />
          <Field
            label="Landing page"
            value={
              briefPayload?.landing_page_url ? (
                <a
                  href={briefPayload.landing_page_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="break-all underline-offset-4 hover:underline"
                >
                  {briefPayload.landing_page_url}
                </a>
              ) : (
                "—"
              )
            }
          />
        </dl>
      </header>

      {payload.issues.length > 0 ? (
        <section
          className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm"
          aria-label="Launch validation issues"
        >
          <h2 className="font-semibold text-amber-900">
            Validation issues ({payload.issues.length})
          </h2>
          <ul className="space-y-1">
            {payload.issues.map((issue, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span
                  className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-xs font-medium uppercase ${
                    issue.severity === "error"
                      ? "bg-rose-100 text-rose-800"
                      : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {issue.severity}
                </span>
                <span className="flex-1 text-amber-900">{issue.message}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Approved creatives ({creatives.length})</h2>
        {creatives.length === 0 ? (
          <p className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            No approved creatives bundled with this launch yet.
          </p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 md:grid-cols-2">
            {creatives.map((c) => {
              const url = signedUrls[c.id] ?? null;
              const copies = copyByCreativeId[c.id] ?? [];
              return (
                <li key={c.id} className="overflow-hidden rounded-md border bg-card shadow-sm">
                  <div className="relative aspect-square bg-muted">
                    {url ? (
                      <Image
                        src={url}
                        alt={c.concept ?? "creative"}
                        fill
                        sizes="(max-width: 768px) 100vw, 50vw"
                        className="object-cover"
                        unoptimized
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        no preview
                      </div>
                    )}
                  </div>
                  <div className="space-y-3 p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-base font-medium">{c.concept ?? "Untitled concept"}</h3>
                      {c.ratio ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${RATIO_BADGE[c.ratio] ?? "bg-zinc-100 text-zinc-700"}`}
                        >
                          {c.ratio}
                        </span>
                      ) : null}
                    </div>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <p>
                        <span className="font-medium text-foreground">Version:</span> {c.version}
                      </p>
                      <p>
                        <span className="font-medium text-foreground">Drive:</span>{" "}
                        {c.file_path_drive ? (
                          <a
                            href={c.file_path_drive}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="break-all underline-offset-4 hover:underline"
                          >
                            View in Drive
                          </a>
                        ) : (
                          <span className="text-rose-600">missing</span>
                        )}
                      </p>
                    </div>

                    {copies.length === 0 ? (
                      <p className="text-xs text-rose-600">No paired copy variants.</p>
                    ) : (
                      <ul className="space-y-2 border-t pt-3">
                        {copies.map((cv) => (
                          <li key={cv.id} className="space-y-0.5 text-xs">
                            {cv.headline ? <p className="font-semibold">{cv.headline}</p> : null}
                            {cv.body ? <p className="text-muted-foreground">{cv.body}</p> : null}
                            {cv.cta ? (
                              <p className="font-medium text-foreground">CTA: {cv.cta}</p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-2 rounded-md border bg-muted/20 p-4 text-xs text-muted-foreground">
        <h2 className="text-sm font-semibold text-foreground">Validation</h2>
        <p>
          Verdict via <span className="font-mono">{payload.validation.via}</span>:{" "}
          <span className={payload.validation.ok ? "text-emerald-700" : "text-rose-700"}>
            {payload.validation.ok ? "ok" : "issues present"}
          </span>
        </p>
        {payload.validation.raw_stderr ? (
          <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted p-2 text-xs">
            {payload.validation.raw_stderr}
          </pre>
        ) : null}
      </section>
    </section>
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
