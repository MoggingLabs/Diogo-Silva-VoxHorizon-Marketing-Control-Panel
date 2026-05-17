/**
 * Tests for `app/api/launches/video/route.ts` (POST + GET).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();
const callWorkerMock = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));
vi.mock("@/lib/worker", () => {
  class WorkerError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = "WorkerError";
      this.status = status;
    }
  }
  return {
    callWorker: (...args: unknown[]) => callWorkerMock(...args),
    WorkerError,
    worker: { health: () => Promise.resolve({ ok: true }) },
  };
});

import { GET, POST } from "./route";

const briefId = "11111111-1111-4111-8111-111111111111";

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

const baseBrief = {
  id: briefId,
  brief_id_human: "ACME-V-0001",
  status: "approved",
  payload: {},
  target_duration_s: 30,
  voice_id: "voice-1",
  dimensions: "9x16",
  client_id: "c1",
  clients: { id: "c1", slug: "acme", name: "Acme" },
};

const approvedVideoCreative = {
  id: "33333333-3333-4333-8333-333333333333",
  version: 1,
  status: "approved",
  captioned_path: "captions/x.srt",
  composed_path: "videos/x.mp4",
  drive_url: "https://drive.google.com/x",
  duration_actual_s: 30,
};

const copyVariant = {
  id: "44444444-4444-4444-8444-444444444444",
  creative_id: "33333333-3333-4333-8333-333333333333",
  headline: "h",
  body: "b",
  cta: "go",
  status: "approved",
};

describe("POST /api/launches/video", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
    callWorkerMock.mockReset();
  });

  it("happy path (201)", async () => {
    callWorkerMock.mockResolvedValueOnce({ ok: true, issues: [] });
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { single: { data: baseBrief, error: null } } },
      video_creatives: { select: { data: [approvedVideoCreative], error: null } },
      video_copy_variants: { select: { data: [copyVariant], error: null } },
      video_launch_packages: {
        insert: { single: { data: { id: "vlp1", status: "posted" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/launches/video", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("400 invalid JSON", async () => {
    const res = await POST(
      req("http://localhost/api/launches/video", { method: "POST", body: "{" }),
    );
    expect(res.status).toBe(400);
  });

  it("400 validation_failed", async () => {
    const res = await POST(
      req("http://localhost/api/launches/video", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("500 brief read err", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req("http://localhost/api/launches/video", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(500);
  });

  it("404 brief missing", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req("http://localhost/api/launches/video", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("409 wrong brief state", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: {
        select: { single: { data: { ...baseBrief, status: "draft" }, error: null } },
      },
    });
    const res = await POST(
      req("http://localhost/api/launches/video", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(409);
  });

  it("500 video_creatives read err", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { single: { data: baseBrief, error: null } } },
      video_creatives: { select: { data: null, error: { message: "x" } } },
    });
    const res = await POST(
      req("http://localhost/api/launches/video", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(500);
  });

  it("500 copy_variants read err", async () => {
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { single: { data: baseBrief, error: null } } },
      video_creatives: { select: { data: [approvedVideoCreative], error: null } },
      video_copy_variants: { select: { data: null, error: { message: "x" } } },
    });
    const res = await POST(
      req("http://localhost/api/launches/video", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(500);
  });

  it("422 preflight failure (no creatives)", async () => {
    callWorkerMock.mockResolvedValueOnce({ ok: true, issues: [] });
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { single: { data: baseBrief, error: null } } },
      video_creatives: { select: { data: [], error: null } },
      video_launch_packages: {
        insert: { single: { data: { id: "vlp2", status: "failed" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/launches/video", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("422 missing captioned/drive/copy (preflight)", async () => {
    callWorkerMock.mockResolvedValueOnce({ ok: true, issues: [] });
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { single: { data: baseBrief, error: null } } },
      video_creatives: {
        select: {
          data: [
            {
              ...approvedVideoCreative,
              captioned_path: null,
              drive_url: null,
            },
          ],
          error: null,
        },
      },
      video_copy_variants: { select: { data: [], error: null } },
      video_launch_packages: {
        insert: { single: { data: { id: "vlp3", status: "failed" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/launches/video", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("degrades when worker is unavailable (still 201)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { WorkerError } = (await import("@/lib/worker")) as unknown as {
      WorkerError: new (msg: string, status?: number) => Error;
    };
    callWorkerMock.mockRejectedValueOnce(new WorkerError("offline", 503));
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { single: { data: baseBrief, error: null } } },
      video_creatives: { select: { data: [approvedVideoCreative], error: null } },
      video_copy_variants: { select: { data: [copyVariant], error: null } },
      video_launch_packages: {
        insert: { single: { data: { id: "vlp4", status: "posted" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/launches/video", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(201);
    warn.mockRestore();
  });

  it("logs but degrades on plain Error worker reject", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    callWorkerMock.mockRejectedValueOnce(new Error("rando"));
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { single: { data: baseBrief, error: null } } },
      video_creatives: { select: { data: [approvedVideoCreative], error: null } },
      video_copy_variants: { select: { data: [copyVariant], error: null } },
      video_launch_packages: {
        insert: { single: { data: { id: "vlp5", status: "posted" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/launches/video", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(201);
    warn.mockRestore();
  });

  it("422 when worker reports not-ok", async () => {
    callWorkerMock.mockResolvedValueOnce({ ok: false, issues: ["bad"] });
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { single: { data: baseBrief, error: null } } },
      video_creatives: { select: { data: [approvedVideoCreative], error: null } },
      video_copy_variants: { select: { data: [copyVariant], error: null } },
      video_launch_packages: {
        insert: { single: { data: { id: "vlp6", status: "failed" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/launches/video", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("500 when insert fails", async () => {
    callWorkerMock.mockResolvedValueOnce({ ok: true, issues: [] });
    currentSupabase = mockSupabaseClient({
      video_briefs: { select: { single: { data: baseBrief, error: null } } },
      video_creatives: { select: { data: [approvedVideoCreative], error: null } },
      video_copy_variants: { select: { data: [copyVariant], error: null } },
      video_launch_packages: {
        insert: { single: { data: null, error: { message: "dup" } } },
      },
    });
    const res = await POST(
      req("http://localhost/api/launches/video", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(500);
  });
});

describe("GET /api/launches/video", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("200 list", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: { select: { data: [{ id: "vlp1" }], error: null } },
    });
    const res = await GET(req("http://localhost/api/launches/video"));
    expect(res.status).toBe(200);
  });

  it("200 with filters", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: { select: { data: [], error: null } },
    });
    const res = await GET(
      req(`http://localhost/api/launches/video?brief_id=${briefId}&status=posted`),
    );
    expect(res.status).toBe(200);
  });

  it("500 on error", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: { select: { data: null, error: { message: "x" } } },
    });
    const res = await GET(req("http://localhost/api/launches/video"));
    expect(res.status).toBe(500);
  });
});
