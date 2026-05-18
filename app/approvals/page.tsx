import type { Route } from "next";
import Link from "next/link";

import { ApprovalStatusEnum, ApprovalDecisionEnum, type Approval } from "@/lib/approvals/types";
import { createAdminClient } from "@/lib/supabase/admin";

import { ApprovalsTable } from "./ApprovalsTable";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Approvals — VoxHorizon",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Full audit log of every approval the dashboard has seen. Filterable by:
 *   - status   (default: all statuses)
 *   - session  (`ekko_session_id`)
 *   - tool     (`tool_name` exact match)
 *   - decision (`approved | rejected | approved_with_caveat`)
 *
 * Rendered server-side via the admin client — no realtime needed, since
 * audit history is read-only here.
 */
export default async function ApprovalsAuditPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const statusParam = first(params.status);
  const sessionParam = first(params.session);
  const toolParam = first(params.tool);
  const decisionParam = first(params.decision);

  const supabase = createAdminClient();
  // Cast to `any` until Wave 22 regenerates the Supabase types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = (supabase as any)
    .from("approvals")
    .select("*")
    .order("requested_at", { ascending: false })
    .limit(200);

  const status =
    statusParam && ApprovalStatusEnum.safeParse(statusParam).success ? statusParam : undefined;
  if (status) q = q.eq("status", status);
  if (sessionParam) q = q.eq("ekko_session_id", sessionParam);
  if (toolParam) q = q.eq("tool_name", toolParam);
  if (decisionParam && ApprovalDecisionEnum.safeParse(decisionParam).success) {
    q = q.eq("decision", decisionParam);
  }

  const { data, error } = await q;
  const approvals = ((data ?? []) as unknown as Approval[]).slice();

  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Approvals</h1>
          <p className="text-sm text-muted-foreground">
            All Hermes / Ekko pre-tool-call decisions. Filter by session, tool, or status.
          </p>
        </div>
      </header>

      <Filters
        status={statusParam}
        session={sessionParam}
        tool={toolParam}
        decision={decisionParam}
      />

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          Failed to load approvals: {error.message}
        </div>
      ) : null}

      <ApprovalsTable approvals={approvals} />
    </main>
  );
}

function Filters({
  status,
  session,
  tool,
  decision,
}: {
  status?: string;
  session?: string;
  tool?: string;
  decision?: string;
}) {
  // Build a typed Route href for each link. Next 15's typedRoutes is strict
  // about query params, so we assemble the path manually + cast.
  const statusOptions: Array<{ label: string; value: string | "" }> = [
    { label: "All", value: "" },
    { label: "Pending", value: "pending" },
    { label: "Decided", value: "decided" },
    { label: "Expired", value: "expired" },
    { label: "Cancelled", value: "cancelled" },
  ];
  const decisionOptions: Array<{ label: string; value: string | "" }> = [
    { label: "Any decision", value: "" },
    { label: "Approved", value: "approved" },
    { label: "Rejected", value: "rejected" },
    { label: "Approved (caveat)", value: "approved_with_caveat" },
  ];

  return (
    <form
      action="/approvals"
      method="GET"
      data-testid="approvals-filters"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-end sm:gap-2"
    >
      <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
        Status
        <select
          name="status"
          defaultValue={status ?? ""}
          data-testid="filter-status"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {statusOptions.map((o) => (
            <option key={o.value || "all"} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
        Decision
        <select
          name="decision"
          defaultValue={decision ?? ""}
          data-testid="filter-decision"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {decisionOptions.map((o) => (
            <option key={o.value || "any"} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
        Tool
        <input
          name="tool"
          type="text"
          defaultValue={tool ?? ""}
          placeholder="e.g. read_file"
          data-testid="filter-tool"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
        Session
        <input
          name="session"
          type="text"
          defaultValue={session ?? ""}
          placeholder="ekko_session_id"
          data-testid="filter-session"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <div className="flex gap-2 sm:items-end">
        <button
          type="submit"
          data-testid="filter-apply"
          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Apply
        </button>
        <Link
          href={"/approvals" as Route}
          data-testid="filter-reset"
          className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent"
        >
          Reset
        </Link>
      </div>
    </form>
  );
}
