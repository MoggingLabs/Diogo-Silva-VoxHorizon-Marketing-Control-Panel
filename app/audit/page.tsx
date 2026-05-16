import { AttentionCards } from "@/components/audit/AttentionCards";
import { FormatTabs } from "@/components/audit/FormatTabs";
import { FunnelSankey } from "@/components/audit/FunnelSankey";
import { PerfTable } from "@/components/audit/PerfTable";
import {
  AUDIT_WINDOW_VALUES,
  aggregateFunnel,
  imageRowToAuditRow,
  parseAuditFormat,
  parseAuditWindow,
  videoRowToAuditRow,
  type AuditFormat,
  type AuditRow,
  type AuditWindow,
} from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Audit — VoxHorizon",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickFirst(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Audit page: traffic-light verdicts on every recent campaign pull.
 *
 * Layout (top-to-bottom):
 *
 * 1. Header with title + format tabs + window picker.
 * 2. Top-5 attention cards.
 * 3. Funnel-leak Sankey.
 * 4. Sortable performance table.
 *
 * Rendered server-side so the first paint is data-complete. The PerfTable +
 * FormatTabs are client islands; cards / sankey are pure server output.
 *
 * Data sources by format:
 *
 *   - `image`     → `campaign_perf_image`
 *   - `video`     → `campaign_perf_video`
 *   - `combined`  → both tables (we don't query the `v_campaign_perf` view
 *                   because the view only exposes the common subset; the
 *                   combined table still wants video-only columns when the
 *                   row originated from the video table).
 *
 * The DB has no rows in `campaign_perf_*` yet (M4-1 / M4-13 worker pull
 * lands in a future wave), so the page is built to render gracefully when
 * everything is empty.
 */
export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const format = parseAuditFormat(pickFirst(params.format));
  const window = parseAuditWindow(pickFirst(params.window));

  const { rows, errors } = await loadAuditRows(format, window);
  const funnelTotals = aggregateFunnel(rows);

  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-8 py-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Audit</h1>
          <p className="text-sm text-muted-foreground">
            Daily verdicts on live campaigns — kill / watch / keep, with the reasoning surfaced
            inline.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
          <WindowPicker value={window} />
          <FormatTabs value={format} />
        </div>
      </header>

      {errors.length > 0 ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {errors.length === 1
            ? `Failed to load audit data: ${errors[0]}`
            : `Failed to load audit data: ${errors.join("; ")}`}
        </div>
      ) : null}

      {rows.length === 0 && errors.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <AttentionCards rows={rows} format={format} />
          <FunnelSankey totals={funnelTotals} />
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">All campaigns</h2>
            <PerfTable rows={rows} format={format} />
          </section>
        </>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadAuditRows(
  format: AuditFormat,
  window: AuditWindow,
): Promise<{ rows: AuditRow[]; errors: string[] }> {
  const supabase = await createClient();
  const errors: string[] = [];
  const rows: AuditRow[] = [];

  // We only render the most recent row per (client, campaign) for the
  // selected window. The daily-uniq index already enforces one row per day,
  // so a desc-by-pulled_at + limit gives the latest snapshot without a
  // window function. For v1 we cap at 500 rows total which is plenty for an
  // operator dashboard.
  const LIMIT = 500;

  if (format === "image" || format === "combined") {
    const q = await supabase
      .from("campaign_perf_image")
      .select("*")
      .eq("window_days", window)
      .order("pulled_at", { ascending: false })
      .limit(LIMIT);
    if (q.error) {
      errors.push(`image: ${q.error.message}`);
    } else {
      for (const r of q.data ?? []) rows.push(imageRowToAuditRow(r));
    }
  }

  if (format === "video" || format === "combined") {
    const q = await supabase
      .from("campaign_perf_video")
      .select("*")
      .eq("window_days", window)
      .order("pulled_at", { ascending: false })
      .limit(LIMIT);
    if (q.error) {
      errors.push(`video: ${q.error.message}`);
    } else {
      for (const r of q.data ?? []) rows.push(videoRowToAuditRow(r));
    }
  }

  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Subcomponents (kept inline — they're trivial)
// ---------------------------------------------------------------------------

function WindowPicker({ value }: { value: AuditWindow }) {
  return (
    <div
      role="group"
      aria-label="Audit window"
      className="inline-flex items-center rounded-md border border-border bg-card p-1 text-sm shadow-sm"
    >
      {AUDIT_WINDOW_VALUES.map((opt) => {
        const selected = opt === value;
        const href = opt === 30 ? "/audit" : `/audit?window=${opt}`;
        return (
          <a
            key={opt}
            href={href}
            className={
              "rounded px-3 py-1 transition-colors " +
              (selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground")
            }
            aria-current={selected ? "page" : undefined}
          >
            {opt}d
          </a>
        );
      })}
    </div>
  );
}

function EmptyState() {
  return (
    <section className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-card px-6 py-16 text-center shadow-sm">
      <h2 className="text-xl font-semibold">No audit data yet</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Run the daily audit cron once your worker is connected (M4-8). Until then the Meta + GHL
        pull lands no rows and the tables stay empty.
      </p>
      <p className="max-w-md text-xs text-muted-foreground">
        The page itself is wired and ready — verdicts, cards, sankey, and the sortable table will
        populate as soon as the worker writes rows to
        <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono">campaign_perf_image</code>
        or
        <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono">campaign_perf_video</code>.
      </p>
    </section>
  );
}
