/**
 * DORMANT SINCE 2026-05-18 — Slack pivot.
 *
 * The high-urgency approval notification path moved from Resend email to
 * Slack chat.postMessage. The active fan-out lives in
 * `worker/src/services/approval_notifications.py` (`_post_slack`). This
 * template + its route (`app/api/internal/approval-email/route.ts`) are
 * preserved in the tree as dormant code so a future operator decision to
 * revive email-based alerts is a one-config-flag flip rather than a
 * full re-implementation.
 *
 * High-urgency approval email template (HI-17).
 *
 * Rendered by `app/api/internal/approval-email/route.ts` and shipped via
 * Resend when the worker classifies an inbound Hermes tool-call approval
 * as high-urgency (either `risk_class === "external-write"` OR
 * `context.estimated_cost > $50`).
 *
 * Design constraints:
 *   - Operators read these on mobile, sometimes mid-meeting, so the
 *     template stays compact: a clear "what tool? how much?" headline,
 *     a brief context block, a JSON args preview (clipped upstream), and
 *     one very obvious CTA button.
 *   - Email clients still pretend it's 2003 — we use react-email's
 *     primitives + Tailwind so the renderer can collapse classes into
 *     inline `style` attributes that Gmail/Outlook actually respect.
 *   - The approval auto-rejects after 10 minutes (see
 *     `worker/src/services/hermes_approval.py::DEFAULT_TIMEOUT_S`), so
 *     the footer reminds the operator there's a hard deadline.
 *
 * Snapshot tests live in `HighUrgencyApprovalEmail.test.tsx` — they
 * exercise the high-cost, external-write, and missing-context paths so
 * design tweaks surface visibly in PRs.
 */
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";

export type HighUrgencyApprovalEmailProps = {
  /** Database id of the approvals row — used to build the click-through URL. */
  approvalId: string;
  /** Short tool name, e.g. "MetaAds.create_campaign" or "Bash". */
  toolName: string;
  /** Pretty-printed JSON of the tool args, already truncated to ~500 chars. */
  toolArgsPreview: string;
  /**
   * Free-form summary keys to render in a small context table. The worker
   * builds this from the approval row's `context` field and drops blanks.
   * Only the keys the operator cares about make it through:
   *   - pipeline_name
   *   - brief_id_human / brief_id
   *   - skill_name
   *   - session_id
   */
  contextSummary?: Record<string, string | number | null | undefined> | null;
  /** Risk classification from Hermes — "external-write", "filesystem", etc. */
  riskClass?: string | null;
  /**
   * Estimated cost in dollars. Worker normalizes to a number; we still
   * defensively format with `toLocaleString` in case a weird value lands.
   */
  estimatedCost?: number | null;
  /**
   * Absolute base URL of the dashboard (e.g. https://dashboard.voxhorizon.com).
   * Joined with `/approvals/{approvalId}` for the CTA. The Next.js route
   * derives this from a server env var so the template stays agnostic.
   */
  dashboardUrl: string;
};

/**
 * Human-readable label for the small key/value summary block.
 * Kept inline so renaming a label doesn't force a re-test.
 */
const SUMMARY_LABELS: Record<string, string> = {
  pipeline_name: "Pipeline",
  brief_id_human: "Brief",
  brief_id: "Brief",
  skill_name: "Skill",
  session_id: "Session",
};

function formatCost(cost: number | null | undefined): string | null {
  if (cost === null || cost === undefined) return null;
  if (!Number.isFinite(cost)) return null;
  // Cap precision at 2 decimals so $50.123 renders as $50.12, not as
  // a string-coerced full precision number.
  return cost.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/**
 * Operator email shown when Hermes wants to run a high-urgency tool call.
 *
 * Pure component — no async, no env reads, no side effects. The route
 * handler is responsible for wiring props and shipping HTML via Resend.
 */
export function HighUrgencyApprovalEmail({
  approvalId,
  toolName,
  toolArgsPreview,
  contextSummary,
  riskClass,
  estimatedCost,
  dashboardUrl,
}: HighUrgencyApprovalEmailProps) {
  const costLabel = formatCost(estimatedCost);
  const heading = costLabel
    ? `Approval needed: ${toolName} (${costLabel})`
    : `Approval needed: ${toolName}`;
  const approvalUrl = `${dashboardUrl.replace(/\/+$/, "")}/approvals/${approvalId}`;

  // Filter the summary down to entries that actually have a non-empty value
  // — `react-email` will render undefined into the DOM as the literal
  // string "undefined" in some clients, which looks unprofessional.
  const summaryEntries = Object.entries(contextSummary ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );

  return (
    <Html>
      <Head />
      <Preview>{heading}</Preview>
      <Tailwind>
        <Body className="bg-slate-50 py-6 font-sans">
          <Container className="mx-auto max-w-[560px] rounded-lg border border-solid border-slate-200 bg-white p-8">
            <Heading as="h1" className="m-0 mb-2 text-xl font-semibold text-slate-900">
              {heading}
            </Heading>
            <Text className="m-0 mb-4 text-sm text-slate-600">
              A Hermes agent is waiting on your approval to run this tool.
            </Text>

            {(riskClass || costLabel) && (
              <Section className="mb-4 rounded-md border border-solid border-amber-200 bg-amber-50 p-3">
                <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-amber-700">
                  Why this is high-urgency
                </Text>
                {riskClass && (
                  <Text className="m-0 mt-1 text-sm text-amber-900">
                    Risk class: <span className="font-mono">{riskClass}</span>
                  </Text>
                )}
                {costLabel && (
                  <Text className="m-0 mt-1 text-sm text-amber-900">
                    Estimated cost: <span className="font-semibold">{costLabel}</span>
                  </Text>
                )}
              </Section>
            )}

            {summaryEntries.length > 0 && (
              <Section className="mb-4">
                <Text className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Context
                </Text>
                {summaryEntries.map(([key, value]) => (
                  <Text key={key} className="m-0 text-sm text-slate-700">
                    <span className="text-slate-500">{SUMMARY_LABELS[key] ?? key}:</span>{" "}
                    <span className="font-medium">{String(value)}</span>
                  </Text>
                ))}
              </Section>
            )}

            <Section className="mb-4">
              <Text className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Tool arguments
              </Text>
              <pre className="m-0 whitespace-pre-wrap break-words rounded-md bg-slate-100 p-3 font-mono text-xs leading-relaxed text-slate-800">
                {toolArgsPreview}
              </pre>
            </Section>

            <Section className="my-6 text-center">
              <Button
                href={approvalUrl}
                className="rounded-md bg-slate-900 px-5 py-3 text-sm font-semibold text-white no-underline"
              >
                Review approval
              </Button>
            </Section>

            <Hr className="my-6 border-slate-200" />
            <Text className="m-0 text-center text-xs text-slate-500">
              Review at dashboard.voxhorizon.com · Approval will auto-reject in 10 minutes
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

export default HighUrgencyApprovalEmail;
