import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Avoid `vi.importActual` here — `lib/worker.ts` is `server-only`, and
// loading the real module from the jsdom project throws at import time.
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
      health: () =>
        (globalThis as unknown as { __workerHealth__: () => unknown }).__workerHealth__(),
    },
    WorkerError,
  };
});

vi.mock("next/headers", () => ({
  headers: async () => (globalThis as unknown as { __headers__: () => unknown }).__headers__(),
}));

const workerHealth = vi.fn();
const headers = vi.fn();
(globalThis as Record<string, unknown>).__workerHealth__ = workerHealth;
(globalThis as Record<string, unknown>).__headers__ = headers;

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  workerHealth.mockReset();
  headers.mockReturnValue({
    get: (k: string) =>
      k === "host" ? "example.test" : k === "x-forwarded-proto" ? "https" : null,
  });
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  vi.restoreAllMocks();
});

import SettingsPage from "./page";

describe("SettingsPage", () => {
  it("renders the healthy state with service / version / uptime", async () => {
    process.env.WORKER_URL = "https://worker.example/api/";
    process.env.NEXT_PUBLIC_APP_VERSION = "v9";
    process.env.NEXT_PUBLIC_BUILD_TIME = "2026-05-17T00:00:00Z";
    workerHealth.mockResolvedValueOnce({
      ok: true,
      service: "worker-svc",
      version: "1.2.3",
      uptime_seconds: 90000,
    });

    const el = await SettingsPage();
    render(el);
    expect(screen.getByText(/Healthy/)).toBeInTheDocument();
    expect(screen.getByText("worker-svc")).toBeInTheDocument();
    expect(screen.getByText(/1d 1h 0m/)).toBeInTheDocument();
    expect(screen.getByText(/v9/)).toBeInTheDocument();
  });

  it("renders the unhealthy state when worker.health throws", async () => {
    workerHealth.mockRejectedValueOnce(new Error("worker down"));
    const el = await SettingsPage();
    render(el);
    expect(screen.getByText(/Unreachable/)).toBeInTheDocument();
    expect(screen.getByText(/worker down/)).toBeInTheDocument();
  });

  it("masks an invalid URL by returning it as-is", async () => {
    process.env.WORKER_URL = "not a valid url";
    workerHealth.mockRejectedValueOnce("string-thrown");
    const el = await SettingsPage();
    render(el);
    expect(screen.getByText("not a valid url")).toBeInTheDocument();
  });

  it("renders '(unset)' when WORKER_URL is empty", async () => {
    delete process.env.WORKER_URL;
    workerHealth.mockResolvedValueOnce({ ok: true });
    const el = await SettingsPage();
    render(el);
    expect(screen.getByText("(unset)")).toBeInTheDocument();
  });

  it("handles uptime formats: seconds, minutes, hours", async () => {
    workerHealth.mockResolvedValueOnce({ ok: true, uptime_seconds: 45 });
    let el = await SettingsPage();
    render(el);
    expect(screen.getByText(/45s/)).toBeInTheDocument();

    workerHealth.mockResolvedValueOnce({ ok: true, uptime_seconds: 90 });
    el = await SettingsPage();
    render(el);
    expect(screen.getAllByText(/1m/).length).toBeGreaterThan(0);

    workerHealth.mockResolvedValueOnce({ ok: true, uptime_seconds: 3700 });
    el = await SettingsPage();
    render(el);
    expect(screen.getAllByText(/1h 1m/).length).toBeGreaterThan(0);
  });

  it("renders dash for invalid uptime", async () => {
    workerHealth.mockResolvedValueOnce({ ok: true, uptime_seconds: -1 });
    const el = await SettingsPage();
    render(el);
    // The dash appears as the uptime row value (and other empty rows).
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders the (unknown) build/version placeholders", async () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.NEXT_PUBLIC_BUILD_TIME;
    delete process.env.VERCEL_DEPLOYMENT_CREATED_AT;
    workerHealth.mockResolvedValueOnce({ ok: true });
    const el = await SettingsPage();
    render(el);
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.getByText(/unknown — set NEXT_PUBLIC_BUILD_TIME/i)).toBeInTheDocument();
  });
});
