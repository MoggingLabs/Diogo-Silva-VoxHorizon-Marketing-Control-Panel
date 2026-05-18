/**
 * DORMANT SINCE 2026-05-18 — Slack pivot.
 *
 * The high-urgency approval notification path moved from Resend email
 * to a direct Slack chat.postMessage call inside the worker. The active
 * surface is `worker/src/services/approval_notifications.py::_post_slack`.
 *
 * This route + its react-email template
 * (`lib/emails/HighUrgencyApprovalEmail.tsx`) are kept in the tree as
 * dormant code so reviving the email channel is a one-config-flag flip
 * rather than a full re-implementation. The Python worker no longer
 * POSTs here in v1; the route stays mounted for parity with the
 * existing tests and for forward compatibility.
 *
 * POST /api/internal/approval-email — HI-17 internal route.
 *
 * The Python worker calls this endpoint after inserting a high-urgency
 * approval row (see `worker/src/services/approval_notifications.py`).
 * It renders the React email template to HTML and ships it via Resend.
 *
 * Why does the worker not call Resend directly? Two reasons:
 *   1. The email template is React+Tailwind, which lives natively in
 *      the Next.js bundle. Re-implementing it in Python would create
 *      two copies that drift.
 *   2. The Resend Node SDK already has first-class react-email support
 *      and handles HTML+plaintext fallbacks. Replicating that against
 *      the raw HTTP API from Python is lossy and brittle.
 *
 * Auth:
 *   Bearer `INTERNAL_API_TOKEN`. This is a NEW shared secret distinct
 *   from `WORKER_SHARED_SECRET` — the worker→Next direction has its own
 *   token so a compromise of either secret has a narrower blast radius.
 *
 * Idempotency:
 *   v1 has none — Resend itself dedupes within a short window for the
 *   same `to + subject + html`, and the worker only fires once per
 *   new row. If the operator observes duplicate emails in prod we'll
 *   add an in-memory LRU here keyed on approvalId.
 */
import { render } from "@react-email/render";
import { NextResponse, type NextRequest } from "next/server";
import { Resend } from "resend";
import { z } from "zod";

import { HighUrgencyApprovalEmail } from "@/lib/emails/HighUrgencyApprovalEmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Default sender shown in the recipient's inbox. Resend requires the
 * domain be verified — `voxhorizon.com` is configured in the Resend
 * dashboard and routes through DKIM/SPF/DMARC for deliverability.
 */
const DEFAULT_FROM = "VoxHorizon Approvals <approvals@voxhorizon.com>";

/**
 * Fallback dashboard URL when neither `NEXT_PUBLIC_DASHBOARD_URL` nor
 * `VERCEL_URL` is set (local dev). Keeps the CTA link clickable in
 * test inboxes without forcing every developer to configure the var.
 */
const DEFAULT_DASHBOARD_URL = "http://localhost:3000";

/**
 * Bearer prefix the worker sends. Constant-time comparison happens
 * via {@link timingSafeEqual} below.
 */
const BEARER_PREFIX = "Bearer ";

/**
 * Wire-shape the worker POSTs. Snake_case fields mirror the Python
 * Supabase row keys so the worker doesn't have to camelCase.
 */
const ApprovalEmailRequest = z.object({
  approval_id: z.string().min(1),
  tool_name: z.string().min(1),
  tool_args_preview: z.string(),
  risk_class: z.string().nullable().optional(),
  estimated_cost: z.number().nullable().optional(),
  context_summary: z.record(z.string(), z.unknown()).nullable().optional(),
});

type ApprovalEmailRequest = z.infer<typeof ApprovalEmailRequest>;

/**
 * Constant-time comparison so an attacker can't time-side-channel the
 * token. The web Buffer API works in both Node and the Vercel runtime.
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Buffers must be the same length for `timingSafeEqual` to evaluate
  // safely; pad-comparing would itself leak length info.
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const aB = enc.encode(a);
  const bB = enc.encode(b);
  let mismatch = 0;
  for (let i = 0; i < aB.length; i++) {
    mismatch |= aB[i]! ^ bB[i]!;
  }
  return mismatch === 0;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function unauthorized(reason: string): NextResponse {
  return NextResponse.json({ error: reason }, { status: 401 });
}

/**
 * Build the absolute dashboard URL used in the CTA button. Order:
 *   1. `NEXT_PUBLIC_DASHBOARD_URL` (operator-configured prod URL).
 *   2. `VERCEL_URL` (auto-set on Vercel previews; we prefix `https://`).
 *   3. Local fallback `http://localhost:3000`.
 */
function resolveDashboardUrl(): string {
  const configured = nonEmpty(process.env.NEXT_PUBLIC_DASHBOARD_URL);
  if (configured) return configured;
  const vercel = nonEmpty(process.env.VERCEL_URL);
  if (vercel) return `https://${vercel}`;
  return DEFAULT_DASHBOARD_URL;
}

/**
 * Compose the email subject from the validated payload. Mirrors the
 * heading in the template so previews + inbox match.
 */
function buildSubject(body: ApprovalEmailRequest): string {
  const cost = body.estimated_cost;
  if (cost !== null && cost !== undefined && Number.isFinite(cost)) {
    const formatted = cost.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
    return `Approval needed: ${body.tool_name} (${formatted})`;
  }
  return `Approval needed: ${body.tool_name}`;
}

/**
 * Convert the wire payload's `context_summary` (Record<string, unknown>)
 * into the template's expected (Record<string, string | number | null>)
 * shape. We string-coerce everything except numbers so the template
 * doesn't have to defend itself.
 */
function normalizeContext(
  raw: Record<string, unknown> | null | undefined,
): Record<string, string | number | null | undefined> {
  if (!raw) return {};
  const out: Record<string, string | number | null | undefined> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number" || typeof v === "string") {
      out[k] = v;
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Auth gate. Fail closed: if the env token is missing or blank, EVERY
  //    request is rejected. The worker has its own log to surface the
  //    misconfiguration; we just refuse to act.
  const expected = nonEmpty(process.env.INTERNAL_API_TOKEN);
  if (!expected) {
    return unauthorized("Internal API token not configured");
  }
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    return unauthorized("Missing or malformed Authorization header");
  }
  const presented = authHeader.slice(BEARER_PREFIX.length).trim();
  if (!timingSafeEqual(presented, expected)) {
    return unauthorized("Invalid bearer token");
  }

  // 2. Validate body. Resend will reject the send anyway if these are
  //    wrong, but a structured 422 here is far more useful than a
  //    raw Resend SDK error string in the worker logs.
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = ApprovalEmailRequest.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const body = parsed.data;

  // 3. Resolve runtime config. Missing keys produce a 503 (config error)
  //    rather than 502 (upstream error) because the operator can fix this.
  const resendKey = nonEmpty(process.env.RESEND_API_KEY);
  const to = nonEmpty(process.env.OPERATOR_EMAIL);
  if (!resendKey || !to) {
    return NextResponse.json(
      {
        error: "email_not_configured",
        has_resend_key: Boolean(resendKey),
        has_operator_email: Boolean(to),
      },
      { status: 503 },
    );
  }
  const from = nonEmpty(process.env.RESEND_FROM_ADDRESS) ?? DEFAULT_FROM;
  const dashboardUrl = resolveDashboardUrl();

  // 4. Render the React tree. `render` is async in react-email v2+;
  //    awaiting before passing the HTML to Resend keeps error handling
  //    inside the same try-block. We call the component as a function
  //    rather than JSX to keep this file pure-TS (no JSX dependency on
  //    the .ts extension) — the React tree is identical either way
  //    because the component is a pure function.
  let html: string;
  try {
    html = await render(
      HighUrgencyApprovalEmail({
        approvalId: body.approval_id,
        toolName: body.tool_name,
        toolArgsPreview: body.tool_args_preview,
        contextSummary: normalizeContext(body.context_summary),
        riskClass: body.risk_class ?? null,
        estimatedCost: body.estimated_cost ?? null,
        dashboardUrl,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "render failed";
    return NextResponse.json({ error: "render_failed", message }, { status: 500 });
  }

  // 5. Ship via Resend. Their SDK returns `{ data, error }` rather than
  //    throwing; both shapes must be handled. A 502 from us tells the
  //    worker "downstream provider rejected" so it can rate-limit
  //    retries — but in practice the worker is fire-and-forget so the
  //    status is informational.
  const resend = new Resend(resendKey);
  const subject = buildSubject(body);

  let resendResult;
  try {
    resendResult = await resend.emails.send({
      from,
      to,
      subject,
      html,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "resend_send_threw";
    return NextResponse.json({ error: "resend_threw", message }, { status: 502 });
  }
  if (resendResult.error) {
    return NextResponse.json(
      { error: "resend_failed", detail: resendResult.error },
      { status: 502 },
    );
  }
  return NextResponse.json(
    { ok: true, id: resendResult.data?.id ?? null, subject },
    { status: 200 },
  );
}
