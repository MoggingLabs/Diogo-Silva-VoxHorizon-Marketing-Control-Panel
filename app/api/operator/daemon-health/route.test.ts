/**
 * Tests for GET /api/operator/daemon-health (silent-failure PR-2a).
 *
 * Verifies:
 *   - happy path returns `{ consumer, freshness:'live' }`.
 *   - missing consumer row returns `{ consumer:null, freshness:'down' }`.
 *   - explicit `status='down'` is surfaced as `freshness:'down'`.
 *   - 500 on DB error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { GET } from "./route";

const LIVE_DAEMON = {
  id: "operator-daemon-1",
  kind: "operator_dispatch",
  status: "live",
  startup_check: { auth: "ok", hermes: "ok" },
  // 1s old at the test clock — fresh.
  last_seen_at: new Date().toISOString(),
  image_tag: "operator:1.2.3",
  hostname: "operator-1",
  created_at: "2026-05-26T11:00:00Z",
  updated_at: new Date().toISOString(),
};

describe("GET /api/operator/daemon-health", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("returns the consumer + freshness='live' (200)", async () => {
    currentSupabase = mockSupabaseClient({
      work_item_consumers: {
        select: { data: null, error: null, single: { data: LIVE_DAEMON, error: null } },
      },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.consumer.id).toBe("operator-daemon-1");
    expect(body.freshness).toBe("live");
  });

  it("returns null consumer + freshness='down' when no row exists", async () => {
    currentSupabase = mockSupabaseClient({
      work_item_consumers: {
        select: { data: null, error: null, single: { data: null, error: null } },
      },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.consumer).toBeNull();
    expect(body.freshness).toBe("down");
  });

  it("surfaces explicit consumer.status='down' as freshness='down'", async () => {
    currentSupabase = mockSupabaseClient({
      work_item_consumers: {
        select: {
          data: null,
          error: null,
          single: {
            data: { ...LIVE_DAEMON, status: "down", startup_check: { auth: "expired" } },
            error: null,
          },
        },
      },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.consumer.status).toBe("down");
    expect(body.freshness).toBe("down");
  });

  it("surfaces consumer.status='starting' as freshness='starting'", async () => {
    currentSupabase = mockSupabaseClient({
      work_item_consumers: {
        select: {
          data: null,
          error: null,
          single: { data: { ...LIVE_DAEMON, status: "starting" }, error: null },
        },
      },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.freshness).toBe("starting");
  });

  it("returns 500 when the DB query errors", async () => {
    currentSupabase = mockSupabaseClient({
      work_item_consumers: {
        select: { data: null, error: null, single: { data: null, error: { message: "boom" } } },
      },
    });
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
