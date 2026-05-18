import { randomUUID } from "node:crypto";

import { test, expect, getTestAdminClient } from "./_fixtures";

/**
 * Happy-path e2e for HI-16 dashboard approval UI.
 *
 * We can't exercise the full Hermes/Ekko round-trip from Playwright (no
 * worker container in CI), so the flow we test is:
 *
 *   1. Seed an `approvals` row with status='pending' via the service-role
 *      client.
 *   2. Open `/approvals` (the audit page is the most deterministic page —
 *      no Realtime needed for the seeded row to be visible).
 *   3. Click the row, press the `A` shortcut.
 *   4. Verify the DB row transitions to status='decided', decision='approved'.
 *
 * The Realtime + modal-auto-open path is covered by unit tests on the hook
 * and the queue component; here we focus on the API → DB round-trip.
 *
 * Cleanup: we delete the seeded approval(s) after each test so the dev DB
 * stays tidy.
 */

const TEST_SESSION_PREFIX = "e2e-approvals";

async function seedApproval(opts: {
  id?: string;
  toolName?: string;
  expiresInMs?: number;
}): Promise<string> {
  const admin = getTestAdminClient();
  const id = opts.id ?? randomUUID();
  const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? 5 * 60_000)).toISOString();
  const session = `${TEST_SESSION_PREFIX}-${id.slice(0, 8)}`;
  // The generated types may not include the `approvals` table yet (Wave 22
  // regenerates them); cast through `unknown` so the seed still type-checks
  // under the e2e tsconfig.
  const fromApprovals = (admin.from as unknown as (t: string) => ReturnType<typeof admin.from>)(
    "approvals",
  );
  const { error } = await fromApprovals.insert({
    id,
    ekko_session_id: session,
    ekko_tool_call_id: `tc-${id.slice(0, 8)}`,
    tool_name: opts.toolName ?? "read_file",
    tool_args: { path: "/etc/hosts" },
    risk_class: "filesystem",
    context: { skill_name: "e2e-test" },
    expires_at: expiresAt,
  } as never);
  if (error) {
    throw new Error(`seedApproval failed: ${error.message}`);
  }
  return id;
}

async function deleteApproval(id: string): Promise<void> {
  const admin = getTestAdminClient();
  const fromApprovals = (admin.from as unknown as (t: string) => ReturnType<typeof admin.from>)(
    "approvals",
  );
  await fromApprovals.delete().eq("id", id);
}

async function fetchApproval(id: string): Promise<Record<string, unknown> | null> {
  const admin = getTestAdminClient();
  const fromApprovals = (admin.from as unknown as (t: string) => ReturnType<typeof admin.from>)(
    "approvals",
  );
  const { data } = await fromApprovals.select("*").eq("id", id).maybeSingle();
  return data as Record<string, unknown> | null;
}

test.describe("approval flow", () => {
  let createdId: string | null = null;

  test.afterEach(async () => {
    if (createdId) {
      await deleteApproval(createdId);
      createdId = null;
    }
  });

  test("seeded approval renders and can be approved via keyboard `A`", async ({ page }) => {
    createdId = await seedApproval({ toolName: "read_file" });

    await page.goto(`/approvals?session=${TEST_SESSION_PREFIX}-${createdId.slice(0, 8)}`);

    // The seeded row's tool name should appear in the audit table.
    await expect(page.getByText("read_file").first()).toBeVisible();

    // Open the modal by clicking the row.
    await page.getByTestId(`approvals-table-row-${createdId}`).click();
    await expect(page.getByTestId("approval-modal")).toBeVisible();

    // Press the keyboard `A` to approve.
    await page.keyboard.press("a");

    // The modal closes after a successful POST; wait for the close.
    await expect(page.getByTestId("approval-modal")).toHaveCount(0, { timeout: 10_000 });

    // Verify the DB row transitioned.
    const updated = await fetchApproval(createdId);
    expect(updated?.status).toBe("decided");
    expect(updated?.decision).toBe("approved");
  });

  test("filter form narrows the audit list to a single session", async ({ page }) => {
    createdId = await seedApproval({ toolName: "unique_tool" });

    await page.goto(
      `/approvals?session=${TEST_SESSION_PREFIX}-${createdId.slice(0, 8)}&tool=unique_tool`,
    );
    // The page renders only the seeded row.
    await expect(page.getByTestId(`approvals-table-row-${createdId}`)).toBeVisible();
    await expect(page.getByText("unique_tool").first()).toBeVisible();
  });
});
