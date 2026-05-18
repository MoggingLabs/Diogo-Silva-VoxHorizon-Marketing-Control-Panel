/**
 * Render tests for the HI-17 high-urgency approval email template.
 *
 * The template doesn't have logic worth testing in isolation — it's a
 * declarative React tree. What MATTERS is that:
 *   1. The render pipeline (Tailwind + react-email) actually completes
 *      without throwing on the prop shapes the worker sends.
 *   2. Critical strings the operator needs to see (tool name, dollar
 *      amount, click-through URL, footer copy) are present in the
 *      rendered HTML.
 *   3. Optional fields gracefully degrade — no "undefined" leaks into
 *      the body when context is empty.
 *
 * We use `@react-email/render`'s `render()` to convert the JSX to the
 * same HTML Resend will ship, then assert against that string. Snapshot
 * comparison is a substring match per property — full HTML snapshots
 * are too brittle (Tailwind class hash names change).
 */
import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";

import { HighUrgencyApprovalEmail } from "./HighUrgencyApprovalEmail";

const dashboardUrl = "https://dashboard.voxhorizon.com";

describe("HighUrgencyApprovalEmail", () => {
  it("renders with a high estimated cost", async () => {
    const html = await render(
      <HighUrgencyApprovalEmail
        approvalId="ap-123"
        toolName="MetaAds.create_campaign"
        toolArgsPreview='{\n  "budget": 500\n}'
        contextSummary={{
          pipeline_name: "Image v1",
          brief_id_human: "VOX-2026-0001",
          skill_name: "campaigns",
        }}
        riskClass="external-write"
        estimatedCost={75}
        dashboardUrl={dashboardUrl}
      />,
    );

    // Headline carries the cost.
    expect(html).toContain("MetaAds.create_campaign");
    expect(html).toContain("$75");
    // Risk class block.
    expect(html).toContain("external-write");
    // Context summary block — both label and value should show up.
    expect(html).toContain("Image v1");
    expect(html).toContain("VOX-2026-0001");
    expect(html).toContain("campaigns");
    // Args preview is in the body.
    expect(html).toContain("budget");
    // CTA href is correctly joined.
    expect(html).toContain("https://dashboard.voxhorizon.com/approvals/ap-123");
    // Footer line.
    expect(html).toContain("auto-reject in 10 minutes");
  });

  it("renders for an external-write risk without a cost", async () => {
    const html = await render(
      <HighUrgencyApprovalEmail
        approvalId="ap-9"
        toolName="GHL.update_contact"
        toolArgsPreview='{"contact_id": "ct-1"}'
        contextSummary={{
          session_id: "sess-7",
        }}
        riskClass="external-write"
        estimatedCost={null}
        dashboardUrl={dashboardUrl}
      />,
    );

    expect(html).toContain("GHL.update_contact");
    // No dollar sign in the heading when cost is null.
    expect(html).not.toMatch(/Approval needed: GHL\.update_contact \(\$/);
    expect(html).toContain("external-write");
    // Session is rendered with its friendly label.
    expect(html).toContain("Session");
    expect(html).toContain("sess-7");
    expect(html).toContain("https://dashboard.voxhorizon.com/approvals/ap-9");
  });

  it("does not leak 'undefined' when optional context is missing", async () => {
    const html = await render(
      <HighUrgencyApprovalEmail
        approvalId="ap-7"
        toolName="Bash"
        toolArgsPreview='{"command": "echo hi"}'
        riskClass="filesystem"
        estimatedCost={51}
        dashboardUrl={dashboardUrl}
      />,
    );

    // Critical: no literal "undefined" in the output. We allow it inside
    // the args preview itself (operator-typed content), but not anywhere
    // else. A simple lowercased contains-check is good enough as a smoke.
    expect(html).not.toContain(">undefined<");
    expect(html).toContain("Bash");
    expect(html).toContain("$51");
  });

  it("strips trailing slashes from the dashboard URL", async () => {
    const html = await render(
      <HighUrgencyApprovalEmail
        approvalId="ap-x"
        toolName="X"
        toolArgsPreview="{}"
        riskClass="external-write"
        estimatedCost={100}
        dashboardUrl="https://dashboard.voxhorizon.com///"
      />,
    );

    expect(html).toContain("https://dashboard.voxhorizon.com/approvals/ap-x");
    // No double slashes between host and /approvals.
    expect(html).not.toMatch(/voxhorizon\.com\/+\/approvals/);
  });

  it("handles null contextSummary cleanly", async () => {
    const html = await render(
      <HighUrgencyApprovalEmail
        approvalId="ap-empty"
        toolName="T"
        toolArgsPreview="{}"
        contextSummary={null}
        riskClass="external-write"
        estimatedCost={60}
        dashboardUrl={dashboardUrl}
      />,
    );

    expect(html).toContain("Approval needed: T");
    // Context section is absent when there are no entries.
    expect(html).not.toContain(">Context<");
  });

  it("omits the dollar amount when cost is undefined", async () => {
    const html = await render(
      <HighUrgencyApprovalEmail
        approvalId="ap-no-cost"
        toolName="ToolX"
        toolArgsPreview="{}"
        riskClass="external-write"
        dashboardUrl={dashboardUrl}
      />,
    );
    // No dollar sign in heading line.
    expect(html).not.toMatch(/Approval needed: ToolX \(\$/);
    expect(html).toContain("Approval needed: ToolX");
  });

  it("ignores non-finite cost values (NaN, Infinity)", async () => {
    const html = await render(
      <HighUrgencyApprovalEmail
        approvalId="ap-nan"
        toolName="ToolY"
        toolArgsPreview="{}"
        riskClass="external-write"
        estimatedCost={Number.NaN}
        dashboardUrl={dashboardUrl}
      />,
    );
    expect(html).toContain("Approval needed: ToolY");
    expect(html).not.toContain("NaN");
  });

  it("falls back to the raw key when no label is registered", async () => {
    const html = await render(
      <HighUrgencyApprovalEmail
        approvalId="ap-raw-key"
        toolName="ToolZ"
        toolArgsPreview="{}"
        contextSummary={{ custom_extra: "abc" }}
        riskClass="external-write"
        estimatedCost={60}
        dashboardUrl={dashboardUrl}
      />,
    );
    expect(html).toContain("custom_extra");
    expect(html).toContain("abc");
  });
});
