/**
 * Tests for `app/api/worker/health/route.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    worker: {
      health: (...args: unknown[]) =>
        (
          globalThis as unknown as { __workerHealthMock: ReturnType<typeof vi.fn> }
        ).__workerHealthMock(...args),
    },
    WorkerError,
    callWorker: () => Promise.resolve({}),
  };
});

const workerHealthMock = vi.fn();
(globalThis as unknown as { __workerHealthMock: typeof workerHealthMock }).__workerHealthMock =
  workerHealthMock;

import { GET } from "./route";

describe("GET /api/worker/health", () => {
  beforeEach(() => {
    workerHealthMock.mockReset();
  });

  it("200 healthy", async () => {
    workerHealthMock.mockResolvedValueOnce({ ok: true, service: "worker" });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worker.service).toBe("worker");
  });

  it("503 on unknown error", async () => {
    workerHealthMock.mockRejectedValueOnce("not-an-error");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Unknown worker error");
  });

  it("forwards WorkerError status when < 600", async () => {
    const { WorkerError } = (await import("@/lib/worker")) as unknown as {
      WorkerError: new (msg: string, status?: number) => Error & { status?: number };
    };
    workerHealthMock.mockRejectedValueOnce(new WorkerError("nope", 502));
    const res = await GET();
    expect(res.status).toBe(502);
  });

  it("503 when WorkerError has no status", async () => {
    const { WorkerError } = (await import("@/lib/worker")) as unknown as {
      WorkerError: new (msg: string, status?: number) => Error & { status?: number };
    };
    workerHealthMock.mockRejectedValueOnce(new WorkerError("offline"));
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it("503 on plain Error", async () => {
    workerHealthMock.mockRejectedValueOnce(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("boom");
  });
});
