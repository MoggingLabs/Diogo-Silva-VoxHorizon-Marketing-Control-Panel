/**
 * Tests for `app/api/pipelines/[id]/advance/route.ts`.
 *
 * The route handles two transitions: `configuration → ideation` and
 * `ideation → review`. Each path has its own gate, RPC, brief inserts,
 * and compensating cleanup branches — we drive every branch.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

// `@/lib/operator/dispatch` imports `server-only`; neutralise it so the jsdom
// route-test project can load the (partially mocked) module.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

// `vi.hoisted` so the spy exists when the hoisted `vi.mock` factory runs.
const { dispatchOperator } = vi.hoisted(() => ({
  dispatchOperator: vi.fn<(id: string, instruction: string) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/operator/dispatch", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/operator/dispatch")>("@/lib/operator/dispatch");
  return { ...actual, dispatchOperator };
});

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

function withRpc(
  client: SupabaseClientMock,
  fn: (name: string) => { data: unknown; error: { message: string } | null },
): SupabaseClientMock {
  (client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc = vi.fn((name: string) =>
    Promise.resolve(fn(name)),
  );
  return client;
}

const validImagePayload = {
  service: "roofing",
  budget: 1000,
  market: "Miami",
};

const validVideoPayload = {
  script_outline: {
    hook: "Discover the best roofing",
    segments: [{ topic: "Intro", duration_s: 30 }],
  },
  target_duration_s: 30,
  voice_id: "voice-1",
  dimensions: "9x16",
  broll_selection_mode: "review_each",
};

const clientId = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  delete process.env.WORKER_URL;
  delete process.env.WORKER_SHARED_SECRET;
  dispatchOperator.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/pipelines/:id/advance", () => {
  it("500 read error", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
      {
        params,
      },
    );
    expect(res.status).toBe(500);
  });

  it("404 not found", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
      {
        params,
      },
    );
    expect(res.status).toBe(404);
  });

  it("422 for unsupported status (review)", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "review" }, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
      {
        params,
      },
    );
    expect(res.status).toBe(422);
  });

  describe("configuration → ideation", () => {
    it("happy path image-only (200)", async () => {
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "image",
                  client_id: clientId,
                  config_draft: { image_payload: validImagePayload },
                  advanced_at: {},
                },
                error: null,
              },
            },
            update: {
              single: { data: { id, status: "ideation" }, error: null },
            },
          },
          clients: { select: { single: { data: { slug: "acme" }, error: null } } },
          briefs: { insert: { single: { data: { id: "ib1" }, error: null } } },
          pipeline_events: { insert: { data: null, error: null } },
        }),
        () => ({ data: "ACME-2026-0001", error: null }),
      );

      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
    });

    it("re-tasks the operator for ideation after approving the brief", async () => {
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "image",
                  client_id: clientId,
                  config_draft: { operator_driven: true, image_payload: validImagePayload },
                  advanced_at: {},
                },
                error: null,
              },
            },
            update: { single: { data: { id, status: "ideation" }, error: null } },
          },
          clients: { select: { single: { data: { slug: "acme" }, error: null } } },
          briefs: { insert: { single: { data: { id: "ib1" }, error: null } } },
          pipeline_events: { insert: { data: null, error: null } },
        }),
        () => ({ data: "ACME-2026-0001", error: null }),
      );

      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
      // The advance fires retaskOperator (await'd internally) which calls dispatch.
      await new Promise((r) => setTimeout(r, 5));
      expect(dispatchOperator).toHaveBeenCalledTimes(1);
      const [pid, instruction] = dispatchOperator.mock.calls[0]!;
      expect(pid).toBe(id);
      expect(instruction.toLowerCase()).toContain("concept");
      // And it records an operator_dispatched event on the timeline.
      expect(currentSupabase._spies.from).toHaveBeenCalledWith("pipeline_events");
    });

    it("advances an operator pipeline whose payload fails the strict form schema", async () => {
      // The operator authors a looser, extras-bearing image_payload (validated
      // by the worker, not the form's BriefPayload). The advance must NOT
      // re-validate it (no "image_payload invalid" 422) and must keep the
      // operator's already-authored image_brief_id.
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "image",
                  client_id: clientId,
                  image_brief_id: "op-brief-1",
                  config_draft: {
                    operator_driven: true,
                    image_payload: { offer_text: "x", extras: { foo: "bar" } },
                  },
                  advanced_at: {},
                },
                error: null,
              },
            },
            update: { single: { data: { id, status: "ideation" }, error: null } },
          },
          pipeline_events: { insert: { data: null, error: null } },
        }),
        () => ({ data: "ACME-2026-0001", error: null }),
      );

      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.image_brief_id).toBe("op-brief-1");
      await new Promise((r) => setTimeout(r, 5));
      expect(dispatchOperator).toHaveBeenCalledTimes(1);
    });

    it("does not block the advance when the operator dispatch rejects", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      dispatchOperator.mockRejectedValueOnce(new Error("operator worker down"));
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "image",
                  client_id: clientId,
                  config_draft: { operator_driven: true, image_payload: validImagePayload },
                  advanced_at: {},
                },
                error: null,
              },
            },
            update: { single: { data: { id, status: "ideation" }, error: null } },
          },
          clients: { select: { single: { data: { slug: "acme" }, error: null } } },
          briefs: { insert: { single: { data: { id: "ib1" }, error: null } } },
          pipeline_events: { insert: { data: null, error: null } },
        }),
        () => ({ data: "ACME-2026-0001", error: null }),
      );
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 5));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("operator worker down"));
      warn.mockRestore();
    });

    it("happy path video-only (200)", async () => {
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "video",
                  client_id: clientId,
                  config_draft: { video_payload: validVideoPayload },
                  advanced_at: null,
                },
                error: null,
              },
            },
            update: { single: { data: { id }, error: null } },
          },
          clients: { select: { single: { data: { slug: "acme" }, error: null } } },
          video_briefs: { insert: { single: { data: { id: "vb1" }, error: null } } },
          pipeline_events: { insert: { data: null, error: null } },
        }),
        () => ({ data: "ACME-V-0001", error: null }),
      );
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
    });

    it("happy path with format=both", async () => {
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "both",
                  client_id: clientId,
                  config_draft: {
                    image_payload: validImagePayload,
                    video_payload: validVideoPayload,
                  },
                  advanced_at: {},
                },
                error: null,
              },
            },
            update: { single: { data: { id }, error: null } },
          },
          clients: { select: { single: { data: { slug: "acme" }, error: null } } },
          briefs: { insert: { single: { data: { id: "ib1" }, error: null } } },
          video_briefs: { insert: { single: { data: { id: "vb1" }, error: null } } },
          pipeline_events: { insert: { data: null, error: null } },
        }),
        (name) =>
          name === "gen_brief_id_human"
            ? { data: "ACME-2026-0001", error: null }
            : { data: "ACME-V-0001", error: null },
      );

      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
    });

    it("422 when config_draft missing required payloads", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: {
            single: {
              data: {
                id,
                status: "configuration",
                format_choice: "image",
                config_draft: null,
                advanced_at: {},
              },
              error: null,
            },
          },
        },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(422);
    });

    it("422 on invalid image payload zod failure", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: {
            single: {
              data: {
                id,
                status: "configuration",
                format_choice: "image",
                config_draft: { image_payload: { service: "bogus" } },
                advanced_at: {},
              },
              error: null,
            },
          },
        },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("image_payload invalid");
    });

    it("422 on invalid video payload zod failure", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: {
            single: {
              data: {
                id,
                status: "configuration",
                format_choice: "video",
                client_id: clientId,
                config_draft: { video_payload: { script_outline: { hook: "x" } } },
                advanced_at: {},
              },
              error: null,
            },
          },
        },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(422);
    });

    it("422 when client_id missing", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: {
            single: {
              data: {
                id,
                status: "configuration",
                format_choice: "image",
                client_id: null,
                config_draft: { image_payload: validImagePayload },
                advanced_at: {},
              },
              error: null,
            },
          },
        },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(422);
    });

    it("500 when client lookup errors", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: {
            single: {
              data: {
                id,
                status: "configuration",
                format_choice: "image",
                client_id: clientId,
                config_draft: { image_payload: validImagePayload },
                advanced_at: {},
              },
              error: null,
            },
          },
        },
        clients: { select: { single: { data: null, error: { message: "boom" } } } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(500);
    });

    it("422 when client not found", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: {
            single: {
              data: {
                id,
                status: "configuration",
                format_choice: "image",
                client_id: clientId,
                config_draft: { image_payload: validImagePayload },
                advanced_at: {},
              },
              error: null,
            },
          },
        },
        clients: { select: { single: { data: null, error: null } } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(422);
    });

    it("500 when image RPC fails", async () => {
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "image",
                  client_id: clientId,
                  config_draft: { image_payload: validImagePayload },
                  advanced_at: {},
                },
                error: null,
              },
            },
          },
          clients: { select: { single: { data: { slug: "acme" }, error: null } } },
        }),
        () => ({ data: null, error: { message: "rpc fail" } }),
      );
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(500);
    });

    it("500 when image brief insert fails", async () => {
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "image",
                  client_id: clientId,
                  config_draft: { image_payload: validImagePayload },
                  advanced_at: {},
                },
                error: null,
              },
            },
          },
          clients: { select: { single: { data: { slug: "acme" }, error: null } } },
          briefs: { insert: { single: { data: null, error: { message: "dup" } } } },
        }),
        () => ({ data: "X", error: null }),
      );
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(500);
    });

    it("500 when video RPC fails (compensating image delete)", async () => {
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "both",
                  client_id: clientId,
                  config_draft: {
                    image_payload: validImagePayload,
                    video_payload: validVideoPayload,
                  },
                  advanced_at: {},
                },
                error: null,
              },
            },
          },
          clients: { select: { single: { data: { slug: "acme" }, error: null } } },
          briefs: { insert: { single: { data: { id: "ib1" }, error: null } } },
        }),
        (name) =>
          name === "gen_brief_id_human"
            ? { data: "ACME", error: null }
            : { data: null, error: { message: "video rpc fail" } },
      );

      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(500);
    });

    it("500 when video brief insert fails (compensating)", async () => {
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "both",
                  client_id: clientId,
                  config_draft: {
                    image_payload: validImagePayload,
                    video_payload: validVideoPayload,
                  },
                  advanced_at: {},
                },
                error: null,
              },
            },
          },
          clients: { select: { single: { data: { slug: "acme" }, error: null } } },
          briefs: { insert: { single: { data: { id: "ib1" }, error: null } } },
          video_briefs: { insert: { single: { data: null, error: { message: "v dup" } } } },
        }),
        () => ({ data: "ACME", error: null }),
      );

      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(500);
    });

    it("500 when pipeline update fails (compensating cleans both briefs)", async () => {
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "both",
                  client_id: clientId,
                  config_draft: {
                    image_payload: validImagePayload,
                    video_payload: validVideoPayload,
                  },
                  advanced_at: {},
                },
                error: null,
              },
            },
            update: { single: { data: null, error: { message: "race" } } },
          },
          clients: { select: { single: { data: { slug: "acme" }, error: null } } },
          briefs: { insert: { single: { data: { id: "ib1" }, error: null } } },
          video_briefs: { insert: { single: { data: { id: "vb1" }, error: null } } },
        }),
        () => ({ data: "ACME", error: null }),
      );
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(500);
    });

    it("warns when pipeline_events insert fails (still 200)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "image",
                  client_id: clientId,
                  config_draft: { image_payload: validImagePayload },
                  advanced_at: {},
                },
                error: null,
              },
            },
            update: { single: { data: { id }, error: null } },
          },
          clients: { select: { single: { data: { slug: "acme" }, error: null } } },
          briefs: { insert: { single: { data: { id: "ib1" }, error: null } } },
          pipeline_events: { insert: { data: null, error: { message: "events down" } } },
        }),
        () => ({ data: "ACME", error: null }),
      );
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("events down"));
      warn.mockRestore();
    });

    it("warns on worker kick failure (still 200)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.WORKER_URL = "http://worker.local";
      process.env.WORKER_SHARED_SECRET = "secret";
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("oops", { status: 500 }));
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "image",
                  client_id: clientId,
                  config_draft: { image_payload: validImagePayload },
                  advanced_at: {},
                },
                error: null,
              },
            },
            update: { single: { data: { id }, error: null } },
          },
          clients: { select: { single: { data: { slug: "acme" }, error: null } } },
          briefs: { insert: { single: { data: { id: "ib1" }, error: null } } },
          pipeline_events: { insert: { data: null, error: null } },
        }),
        () => ({ data: "ACME", error: null }),
      );
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
      // Allow background worker call to settle before assertions.
      await new Promise((r) => setTimeout(r, 5));
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("does not throw when worker returns 404 (pre-launch behaviour)", async () => {
      process.env.WORKER_URL = "http://worker.local";
      process.env.WORKER_SHARED_SECRET = "secret";
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("nope", { status: 404 }));
      currentSupabase = withRpc(
        mockClient({
          pipelines: {
            select: {
              single: {
                data: {
                  id,
                  status: "configuration",
                  format_choice: "image",
                  client_id: clientId,
                  config_draft: { image_payload: validImagePayload },
                  advanced_at: {},
                },
                error: null,
              },
            },
            update: { single: { data: { id }, error: null } },
          },
          clients: { select: { single: { data: { slug: "acme" }, error: null } } },
          briefs: { insert: { single: { data: { id: "ib1" }, error: null } } },
          pipeline_events: { insert: { data: null, error: null } },
        }),
        () => ({ data: "ACME", error: null }),
      );
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
    });
  });

  describe("ideation → review", () => {
    it("happy path image (200)", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: {
            single: {
              data: {
                id,
                status: "ideation",
                format_choice: "image",
                picks: { image: ["c1"] },
                advanced_at: {},
              },
              error: null,
            },
          },
          update: { single: { data: { id, status: "review" }, error: null } },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
    });

    it("happy path both with arrays of strings (200)", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: {
            single: {
              data: {
                id,
                status: "ideation",
                format_choice: "both",
                picks: { image: ["c1"], video: ["v1"] },
                advanced_at: { ideation: "t" },
              },
              error: null,
            },
          },
          update: { single: { data: { id }, error: null } },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
    });

    it("422 missing image picks", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: {
            single: {
              data: {
                id,
                status: "ideation",
                format_choice: "image",
                picks: {},
                advanced_at: {},
              },
              error: null,
            },
          },
        },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(422);
    });

    it("422 with malformed picks (array)", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: {
            single: {
              data: {
                id,
                status: "ideation",
                format_choice: "image",
                picks: [],
                advanced_at: null,
              },
              error: null,
            },
          },
        },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(422);
    });

    it("filters non-string picks in image array", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: {
            single: {
              data: {
                id,
                status: "ideation",
                format_choice: "image",
                picks: { image: [123, "c1"] },
                advanced_at: {},
              },
              error: null,
            },
          },
          update: { single: { data: { id }, error: null } },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
    });

    it("500 when update fails", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: {
            single: {
              data: {
                id,
                status: "ideation",
                format_choice: "image",
                picks: { image: ["c1"] },
                advanced_at: {},
              },
              error: null,
            },
          },
          update: { single: { data: null, error: { message: "race" } } },
        },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(500);
    });

    it("warns but returns 200 when event insert fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      currentSupabase = mockClient({
        pipelines: {
          select: {
            single: {
              data: {
                id,
                status: "ideation",
                format_choice: "image",
                picks: { image: ["c1"] },
                advanced_at: {},
              },
              error: null,
            },
          },
          update: { single: { data: { id }, error: null } },
        },
        pipeline_events: { insert: { data: null, error: { message: "events down" } } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("events down"));
      warn.mockRestore();
    });
  });

  describe("per-creative gated stages (hard block)", () => {
    function perCreativePipeline(status: string) {
      return {
        id,
        status,
        format_choice: "image",
        config_draft: null,
        advanced_at: {},
      };
    }

    it("advances creative_qa when every creative is passed (200)", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: perCreativePipeline("creative_qa"), error: null } },
          update: { single: { data: { id, status: "compliance_review" }, error: null } },
        },
        creative_stage_state: {
          select: { data: [{ status: "passed" }, { status: "passed" }], error: null },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pipeline.status).toBe("compliance_review");
    });

    it("422 HARD-BLOCKS compliance_review while a creative is failed", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: perCreativePipeline("compliance_review"), error: null } },
        },
        creative_stage_state: {
          select: { data: [{ status: "passed" }, { status: "failed" }], error: null },
        },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.field).toBe("rollup");
      expect(body.stage).toBe("compliance_review");
      expect(body.rollup.blocking).toBe(1);
      expect(String(body.error)).toContain("HARD gate");
    });

    it("422 when no creative_stage_state rows exist (uncleared rollup)", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: perCreativePipeline("compliance_review"), error: null } },
        },
        creative_stage_state: { select: { data: [], error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(422);
    });

    it("500 when the creative_stage_state read errors", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: perCreativePipeline("creative_qa"), error: null } },
        },
        creative_stage_state: {
          select: { data: null, error: { message: "rollup read failed" } },
        },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(500);
    });

    it("treats overridden + skipped as cleared and advances compliance_review", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: perCreativePipeline("compliance_review"), error: null } },
          update: { single: { data: { id, status: "copy" }, error: null } },
        },
        creative_stage_state: {
          select: { data: [{ status: "overridden" }, { status: "skipped" }], error: null },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pipeline.status).toBe("copy");
    });

    it("blocked -> override -> advances (integration of the hard gate)", async () => {
      // 1. Blocked: a failed compliance unit holds the gate shut (422).
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: perCreativePipeline("compliance_review"), error: null } },
        },
        creative_stage_state: {
          select: { data: [{ status: "failed" }], error: null },
        },
      });
      const blocked = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(blocked.status).toBe(422);

      // 2. Override (simulated by the manager route): the unit is now overridden.
      // 3. Re-advance: the rollup now reads as cleared, so the gate opens.
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: perCreativePipeline("compliance_review"), error: null } },
          update: { single: { data: { id, status: "copy" }, error: null } },
        },
        creative_stage_state: {
          select: { data: [{ status: "overridden" }], error: null },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const advanced = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(advanced.status).toBe(200);
      const body = await advanced.json();
      expect(body.pipeline.status).toBe("copy");
    });

    it("500 when the pipeline update races (compare-and-set miss)", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: perCreativePipeline("spec_validation"), error: null } },
          update: { single: { data: null, error: { message: "race" } } },
        },
        creative_stage_state: { select: { data: [{ status: "passed" }], error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(500);
    });

    it("warns but returns 200 when the stage_advanced event insert fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: perCreativePipeline("spec_validation"), error: null } },
          update: { single: { data: { id, status: "variant_plan" }, error: null } },
        },
        creative_stage_state: { select: { data: [{ status: "passed" }], error: null } },
        pipeline_events: { insert: { data: null, error: { message: "events down" } } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("events down"));
      warn.mockRestore();
    });
  });

  describe("copy → spec_validation (approved-copy gate, no-stall wiring)", () => {
    function copyPipeline() {
      return {
        id,
        status: "copy",
        format_choice: "image",
        config_draft: null,
        advanced_at: {},
      };
    }

    // The copy gate re-derives ≥3 approved copy variants per in-scope creative
    // (NOT the creative_stage_state rollup, which the operator copy tool only
    // ever rolls to in_progress — gating on it would stall the stage).
    it("advances when every creative has >=3 approved copy variants (200)", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: copyPipeline(), error: null } },
          update: { single: { data: { id, status: "spec_validation" }, error: null } },
        },
        creatives: { select: { data: [{ id: "c1", status: "draft" }], error: null } },
        copy_variants: {
          select: {
            data: [
              { creative_id: "c1", status: "approved" },
              { creative_id: "c1", status: "approved" },
              { creative_id: "c1", status: "approved" },
            ],
            error: null,
          },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pipeline.status).toBe("spec_validation");
    });

    it("422 when a creative is short on approved copy", async () => {
      currentSupabase = mockClient({
        pipelines: { select: { single: { data: copyPipeline(), error: null } } },
        creatives: { select: { data: [{ id: "c1", status: "draft" }], error: null } },
        copy_variants: {
          select: { data: [{ creative_id: "c1", status: "approved" }], error: null },
        },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.field).toBe("copy");
      expect(body.copy.short).toBe(1);
    });

    it("422 when no in-scope creatives exist", async () => {
      currentSupabase = mockClient({
        pipelines: { select: { single: { data: copyPipeline(), error: null } } },
        creatives: { select: { data: [{ id: "c1", status: "killed" }], error: null } },
        copy_variants: { select: { data: [], error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(422);
    });

    it("500 when the creatives read errors", async () => {
      currentSupabase = mockClient({
        pipelines: { select: { single: { data: copyPipeline(), error: null } } },
        creatives: { select: { data: null, error: { message: "boom" } } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(500);
    });

    it("500 when the copy_variants read errors", async () => {
      currentSupabase = mockClient({
        pipelines: { select: { single: { data: copyPipeline(), error: null } } },
        creatives: { select: { data: [{ id: "c1", status: "draft" }], error: null } },
        copy_variants: { select: { data: null, error: { message: "boom" } } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(500);
    });
  });

  describe("finalize_assets → launch_handoff (no-stall wiring)", () => {
    function finalizePipeline() {
      return {
        id,
        status: "finalize_assets",
        format_choice: "image",
        config_draft: null,
        advanced_at: {},
      };
    }

    it("advances when every creative is finalize_verified (200)", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: finalizePipeline(), error: null } },
          update: { single: { data: { id, status: "launch_handoff" }, error: null } },
        },
        creatives: {
          select: {
            data: [
              { id: "c1", finalize_verified: true },
              { id: "c2", finalize_verified: true },
            ],
            error: null,
          },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pipeline.status).toBe("launch_handoff");
    });

    it("422 when a creative is not finalize_verified (gate holds)", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: finalizePipeline(), error: null } },
        },
        creatives: {
          select: {
            data: [
              { id: "c1", finalize_verified: true },
              { id: "c2", finalize_verified: false },
            ],
            error: null,
          },
        },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.field).toBe("finalize");
      expect(body.finalize.unverified).toBe(1);
    });

    it("422 when no creatives exist for the pipeline (nothing finalized)", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: finalizePipeline(), error: null } },
        },
        creatives: { select: { data: [], error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(422);
    });

    it("500 when the creatives read errors", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: finalizePipeline(), error: null } },
        },
        creatives: { select: { data: null, error: { message: "read failed" } } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(500);
    });

    it("500 when the finalize advance update races", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: finalizePipeline(), error: null } },
          update: { single: { data: null, error: { message: "race" } } },
        },
        creatives: { select: { data: [{ id: "c1", finalize_verified: true }], error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(500);
    });

    it("warns but returns 200 when the stage_advanced event insert fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: finalizePipeline(), error: null } },
          update: { single: { data: { id, status: "launch_handoff" }, error: null } },
        },
        creatives: { select: { data: [{ id: "c1", finalize_verified: true }], error: null } },
        pipeline_events: { insert: { data: null, error: { message: "events down" } } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/advance`, { method: "POST" }),
        { params },
      );
      expect(res.status).toBe(200);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("events down"));
      warn.mockRestore();
    });
  });
});
