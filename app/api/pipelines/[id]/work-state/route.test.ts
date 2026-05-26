/**
 * Tests for GET /api/pipelines/[id]/work-state (silent-failure PR-2a).
 *
 * Verifies the route:
 *   - Returns the shape the dashboard hook expects (one round trip, view-driven).
 *   - 404s when the pipeline is missing OR soft-archived.
 *   - 500s on a DB error.
 *   - Coerces null/missing view columns to safe defaults so a future schema
 *     change can't silently corrupt the panel.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { GET } from "./route";

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function req(): NextRequest {
  return new NextRequest(new Request("http://localhost/api/pipelines/p1/work-state"));
}

const PIPELINE_OK = { id: "p1", deleted_at: null };
const PIPELINE_ARCHIVED = { id: "p1", deleted_at: "2026-05-26T00:00:00Z" };

const ACTIVE_WORK_ITEM = {
  id: "wi-1",
  kind: "operator_dispatch",
  pipeline_id: "p1",
  status: "running",
  attempt: 1,
  payload: {},
  result: null,
  error_kind: null,
  error_detail: null,
  heartbeat_at: "2026-05-26T12:00:00Z",
  created_at: "2026-05-26T11:55:00Z",
};

const RECENT_EVENTS = [
  {
    id: "e1",
    pipeline_id: "p1",
    kind: "operator_running",
    stage: "configuration",
    payload: {},
    created_at: "2026-05-26T12:00:00Z",
  },
];

const OPERATOR_DAEMON = {
  id: "operator-daemon-1",
  kind: "operator_dispatch",
  status: "live",
  startup_check: { auth: "ok", hermes: "ok" },
  last_seen_at: "2026-05-26T12:00:00Z",
  image_tag: "operator:1.2.3",
  hostname: "operator-1",
  created_at: "2026-05-26T11:00:00Z",
  updated_at: "2026-05-26T12:00:00Z",
};

describe("GET /api/pipelines/[id]/work-state", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("returns the view-projected envelope (200)", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: { data: null, error: null, single: { data: PIPELINE_OK, error: null } },
      },
      v_pipeline_dispatch_state: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              pipeline_id: "p1",
              derived_status: "configuration",
              active_work_item: ACTIVE_WORK_ITEM,
              recent_events: RECENT_EVENTS,
              operator_daemon: OPERATOR_DAEMON,
            },
            error: null,
          },
        },
      },
    });

    const res = await GET(req(), ctx("p1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pipelineId).toBe("p1");
    expect(body.derivedStatus).toBe("configuration");
    expect(body.activeWorkItem.id).toBe("wi-1");
    expect(body.recentEvents).toHaveLength(1);
    expect(body.operatorDaemon.status).toBe("live");
  });

  it("returns 404 when the pipeline row is missing", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: { data: null, error: null, single: { data: null, error: null } },
      },
    });
    const res = await GET(req(), ctx("missing"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the pipeline is soft-archived", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: { data: null, error: null, single: { data: PIPELINE_ARCHIVED, error: null } },
      },
    });
    const res = await GET(req(), ctx("p1"));
    expect(res.status).toBe(404);
  });

  it("returns 500 when the pipelines lookup errors", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          data: null,
          error: null,
          single: { data: null, error: { message: "boom" } },
        },
      },
    });
    const res = await GET(req(), ctx("p1"));
    expect(res.status).toBe(500);
  });

  it("returns 500 when the view query errors", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: { data: null, error: null, single: { data: PIPELINE_OK, error: null } },
      },
      v_pipeline_dispatch_state: {
        select: {
          data: null,
          error: null,
          single: { data: null, error: { message: "view broke" } },
        },
      },
    });
    const res = await GET(req(), ctx("p1"));
    expect(res.status).toBe(500);
  });

  it("returns 404 when the view returns no row (defensive)", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: { data: null, error: null, single: { data: PIPELINE_OK, error: null } },
      },
      v_pipeline_dispatch_state: {
        select: { data: null, error: null, single: { data: null, error: null } },
      },
    });
    const res = await GET(req(), ctx("p1"));
    expect(res.status).toBe(404);
  });

  it("coerces null view columns to safe defaults", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: { data: null, error: null, single: { data: PIPELINE_OK, error: null } },
      },
      v_pipeline_dispatch_state: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              pipeline_id: "p1",
              derived_status: null,
              active_work_item: null,
              recent_events: null,
              operator_daemon: null,
            },
            error: null,
          },
        },
      },
    });
    const res = await GET(req(), ctx("p1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.derivedStatus).toBe("configuration");
    expect(body.activeWorkItem).toBeNull();
    expect(body.recentEvents).toEqual([]);
    expect(body.operatorDaemon).toBeNull();
  });
});
