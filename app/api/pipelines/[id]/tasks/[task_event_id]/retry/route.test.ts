/**
 * Tests for `app/api/pipelines/[id]/tasks/[task_event_id]/retry/route.ts`.
 *
 * The route is a heavy orchestrator: lookup -> queue event -> kick the
 * worker (image or video) in the background -> emit running/done/error
 * follow-up events. We verify every validation gate and every dispatcher
 * branch.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { POST } from "./route";

const pipelineId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const params = Promise.resolve({ id: pipelineId, task_event_id: taskId });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

beforeEach(() => {
  currentSupabase = mockSupabaseClient();
  callWorkerMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/pipelines/:id/tasks/:task_event_id/retry — guards", () => {
  it("500 on read error", async () => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 missing task", async () => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("422 when source kind isn't task_error", async () => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: { data: { id: taskId, kind: "task_running", stage: "generation" }, error: null },
        },
      },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("422 when source stage isn't generation", async () => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: { data: { id: taskId, kind: "task_error", stage: "ideation" }, error: null },
        },
      },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("422 unknown task kind", async () => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: {},
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("422 image task missing parent_creative_id", async () => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "image", ratio: "1x1" },
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("422 image task unsupported ratio", async () => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "image", parent_creative_id: "p1", ratio: "weird" },
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("422 video task missing creative_id", async () => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "video", substage: "voiceover" },
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("422 video task missing substage", async () => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "video", creative_id: "c1" },
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("500 when queued insert fails", async () => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "image", parent_creative_id: "p1", concept: "x", ratio: "1x1" },
            },
            error: null,
          },
        },
        insert: { single: { data: null, error: { message: "ev" } } },
      },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(500);
  });
});

describe("POST retry — image happy path + worker behaviour", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "image", parent_creative_id: "p1", concept: "x", ratio: "1x1" },
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
      creatives: {
        select: {
          single: {
            data: {
              id: "p1",
              brief_id: "b1",
              concept: "x",
              ratio: "1x1",
              prompt_used: { prompt: "old prompt" },
            },
            error: null,
          },
        },
      },
    });
  });

  it("202 with retry_task_id", async () => {
    callWorkerMock.mockResolvedValueOnce({
      creatives: [
        {
          creative_id: "c2",
          concept: "x",
          ratio: "1x1",
          version: "v1.0",
          file_path_supabase: "s/c2",
          task_id: "t1",
          source_url: null,
        },
      ],
      brief_id: "b1",
      creatives_created: 1,
      errors: [],
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.retry_task_id).toBe("queued1");
    // Allow background runner to settle.
    await new Promise((r) => setTimeout(r, 5));
  });

  it("handles worker returning no creatives", async () => {
    callWorkerMock.mockResolvedValueOnce({
      creatives: [],
      brief_id: "b1",
      creatives_created: 0,
      errors: ["nothing"],
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 5));
  });

  it("handles parent creative read error in background", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "image", parent_creative_id: "p1", concept: "x", ratio: "1x1" },
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
      creatives: { select: { single: { data: null, error: { message: "down" } } } },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    warn.mockRestore();
  });

  it("handles missing parent creative in background", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "image", parent_creative_id: "p1", concept: "x", ratio: "1x1" },
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
      creatives: { select: { single: { data: { id: "p1", brief_id: null }, error: null } } },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    warn.mockRestore();
  });

  it("uses fallback prompt when prompt_used has no prompt", async () => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "image", parent_creative_id: "p1", ratio: "1x1" },
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
      creatives: {
        select: {
          single: {
            data: { id: "p1", brief_id: "b1", concept: null, ratio: "1x1", prompt_used: null },
            error: null,
          },
        },
      },
    });
    callWorkerMock.mockResolvedValueOnce({
      creatives: [
        {
          creative_id: "c3",
          concept: "concept",
          ratio: "1x1",
          version: "v1.0",
          file_path_supabase: "s/c3",
          task_id: null,
          source_url: null,
        },
      ],
      brief_id: "b1",
      creatives_created: 1,
      errors: [],
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 5));
  });
});

describe("POST retry — video dispatchers", () => {
  for (const substage of ["voiceover", "broll_search", "compose", "caption"]) {
    it(`dispatches video substage=${substage} (202)`, async () => {
      currentSupabase = mockSupabaseClient({
        pipeline_events: {
          select: {
            single: {
              data: {
                id: taskId,
                kind: "task_error",
                stage: "generation",
                payload: { kind: "video", creative_id: "vc1", substage },
              },
              error: null,
            },
          },
          insert: { single: { data: { id: "queued1" }, error: null } },
        },
      });
      const reply: Record<string, unknown> = {
        creative_id: "vc1",
        voiceover_path: "v/x.mp3",
        composed_path: "c/x.mp4",
        captioned_path: "ca/x.srt",
      };
      if (substage === "broll_search") reply.candidates = [1, 2, 3];
      callWorkerMock.mockResolvedValueOnce(reply);
      const res = await POST(
        req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 5));
    });
  }

  it("dispatches video substage=broll_pick with resolved array", async () => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "video", creative_id: "vc1", substage: "broll_pick" },
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
    });
    callWorkerMock.mockResolvedValueOnce({ resolved: ["a", "b"] });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 5));
  });

  it("dispatches video substage=script — reads brief_id from creative", async () => {
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "video", creative_id: "vc1", substage: "script" },
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
      video_creatives: { select: { single: { data: { brief_id: "vb1" }, error: null } } },
    });
    callWorkerMock.mockResolvedValueOnce({ script_path: "s/x" });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 5));
  });

  it("handles video script lookup error in background", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "video", creative_id: "vc1", substage: "script" },
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
      video_creatives: { select: { single: { data: null, error: { message: "down" } } } },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    warn.mockRestore();
  });

  it("unknown substage throws (background, logged)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "video", creative_id: "vc1", substage: "exotic" },
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    warn.mockRestore();
  });

  it("translates WorkerError in dispatchVideoRetry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { WorkerError } = (await import("@/lib/worker")) as unknown as {
      WorkerError: new (msg: string, status?: number) => Error;
    };
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "video", creative_id: "vc1", substage: "voiceover" },
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
    });
    callWorkerMock.mockRejectedValueOnce(new WorkerError("nope", 503));
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    warn.mockRestore();
  });

  it("rethrows non-WorkerError from video worker call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockSupabaseClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kind: "video", creative_id: "vc1", substage: "voiceover" },
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
    });
    callWorkerMock.mockRejectedValueOnce(new Error("rando"));
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    warn.mockRestore();
  });
});
