// CI gate: this spec is wired into .github/workflows/ci.yml as a blocking
// matrix entry (`allow_failure: false`) — the WorkItemPanel + DaemonHealthBadge
// are the canonical surfaces for the silent-failure rebuild and CI must catch
// any regression in the queued / live / down rendering before merge.
import { randomUUID } from "node:crypto";

import { test, expect, getTestAdminClient, seedPipeline } from "./_fixtures";

/**
 * Silent-failure PR-2a: e2e for the new read surfaces.
 *
 * Two scenarios:
 *
 *  1. Happy seeded path: a fresh pipeline gets a `work_item` row in the
 *     `queued` state plus a `work_item_consumers` row in `live`. The pipeline
 *     detail page renders the WorkItemPanel showing the queued state and the
 *     DaemonHealthBadge showing live.
 *
 *  2. Daemon-down recovery: a `work_item_consumers` row with
 *     `status='down', startup_check.auth='expired'` makes the badge red and
 *     the explicit `auth: expired` chip render. This is the bug class the
 *     redesign is built to catch — today silent, in PR-2a explicit.
 *
 * The dispatch panel itself is mounted from the pipeline detail page in PR-3;
 * for PR-2a we hit the dedicated API routes (work-state + daemon-health) the
 * components rely on, then render a small probe page through the global
 * search by deep-linking to a pipeline detail page that already mounts the
 * OperatorConsole's daemon section.
 */

const TEST_CONSUMER_ID = "e2e-operator-daemon";

async function seedWorkItem(opts: {
  pipelineId: string;
  status?: "queued" | "claimed" | "running" | "failed" | "completed";
  idempotencyKey?: string;
}): Promise<string> {
  const admin = getTestAdminClient();
  const id = randomUUID();
  // The generated types may not know about work_item in older snapshots; the
  // permissive cast lets the seed run under the e2e tsconfig without
  // depending on a typegen pass.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (admin.from as unknown as (t: string) => any)("work_item");
  const { error } = await from.insert({
    id,
    kind: "operator_dispatch",
    pipeline_id: opts.pipelineId,
    status: opts.status ?? "queued",
    payload: { stage: "configuration", instruction: "kickoff" },
    idempotency_key:
      opts.idempotencyKey ?? `op-disp:${opts.pipelineId}:configuration:${randomUUID().slice(0, 8)}`,
    created_by: "e2e/work-item-panel.spec.ts",
  });
  if (error) throw new Error(`seedWorkItem failed: ${error.message}`);
  return id;
}

async function upsertConsumer(opts: {
  id?: string;
  status: "starting" | "live" | "degraded" | "stopped" | "down";
  startupCheck?: Record<string, string>;
}): Promise<void> {
  const admin = getTestAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (admin.from as unknown as (t: string) => any)("work_item_consumers");
  const { error } = await from.upsert(
    {
      id: opts.id ?? TEST_CONSUMER_ID,
      kind: "operator_dispatch",
      status: opts.status,
      startup_check: opts.startupCheck ?? { auth: "ok", hermes: "ok" },
      last_seen_at: new Date().toISOString(),
      image_tag: "e2e-image:test",
      hostname: "e2e-host",
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(`upsertConsumer failed: ${error.message}`);
}

async function deleteWorkItem(id: string): Promise<void> {
  const admin = getTestAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (admin.from as unknown as (t: string) => any)("work_item");
  await from.delete().eq("id", id);
}

async function deleteConsumer(id: string): Promise<void> {
  const admin = getTestAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (admin.from as unknown as (t: string) => any)("work_item_consumers");
  await from.delete().eq("id", id);
}

test.describe("work-item panel + daemon health badge", () => {
  let workItemId: string | null = null;

  test.afterEach(async () => {
    if (workItemId) {
      await deleteWorkItem(workItemId);
      workItemId = null;
    }
    await deleteConsumer(TEST_CONSUMER_ID);
  });

  test("queued work_item + live daemon both render via /api/* surfaces", async ({
    page,
    clientId,
  }) => {
    const pipelineId = await seedPipeline(clientId, { format_choice: "image" });
    workItemId = await seedWorkItem({ pipelineId, status: "queued" });
    await upsertConsumer({ status: "live" });

    // The OperatorConsole at /pipeline/operator mounts the DaemonHealthBadge.
    await page.goto("/pipeline/operator");

    // The daemon health badge is the canonical UI for daemon status.
    await expect(page.getByTestId("daemon-health-badge")).toHaveAttribute(
      "data-freshness",
      "live",
      { timeout: 15_000 },
    );

    // The dispatch state surface is also probable via the API route. Assert
    // the queued row is reflected in the response (the panel itself mounts
    // from the pipeline detail page in PR-3; PR-2a ships the route + the
    // components that consume it).
    const workStateRes = await page.request.get(`/api/pipelines/${pipelineId}/work-state`);
    expect(workStateRes.status()).toBe(200);
    const workState = await workStateRes.json();
    expect(workState.activeWorkItem?.status).toBe("queued");
    expect(workState.operatorDaemon?.status).toBe("live");
  });

  test("daemon down with auth_expired renders red with the explicit chip", async ({
    page,
    clientId,
  }) => {
    const pipelineId = await seedPipeline(clientId, { format_choice: "image" });
    workItemId = await seedWorkItem({ pipelineId, status: "queued" });
    await upsertConsumer({
      status: "down",
      startupCheck: { auth: "expired", hermes: "ok" },
    });

    await page.goto("/pipeline/operator");

    // The badge flips red.
    await expect(page.getByTestId("daemon-health-badge")).toHaveAttribute(
      "data-freshness",
      "down",
      { timeout: 15_000 },
    );

    // The auth-expired chip is explicit, no hover.
    await expect(page.getByTestId("daemon-startup-check-auth")).toHaveText(/auth: expired/i);

    // The API surface mirrors the badge.
    const healthRes = await page.request.get("/api/operator/daemon-health");
    expect(healthRes.status()).toBe(200);
    const health = await healthRes.json();
    expect(health.consumer?.status).toBe("down");
    expect(health.freshness).toBe("down");
  });
});
