"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

type WorkerHealthPayload = {
  ok: boolean;
  service?: string;
  version?: string;
  uptime_seconds?: number;
  claude_code_available?: boolean;
  queue_depth?:
    | number
    | {
        image?: number;
        video?: number;
        broll?: number;
        total?: number;
        [key: string]: number | undefined;
      };
  [key: string]: unknown;
};

type HealthResult =
  | { ok: true; latencyMs: number; worker: WorkerHealthPayload }
  | { ok: false; latencyMs: number; error: string };

type HealthState = "unknown" | "ok" | "degraded" | "down";

const POLL_INTERVAL_MS = 30_000;
const DEGRADED_LATENCY_MS = 5_000;

function pickQueueCount(
  queue: WorkerHealthPayload["queue_depth"],
  key: "image" | "video" | "broll" | "total",
): number | null {
  if (queue === undefined || queue === null) return null;
  if (typeof queue === "number") return key === "total" ? queue : null;
  const v = queue[key];
  return typeof v === "number" ? v : null;
}

function formatUptime(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${s}s`;
}

function deriveState(result: HealthResult | null): HealthState {
  if (!result) return "unknown";
  if (!result.ok) return "down";
  if (result.latencyMs > DEGRADED_LATENCY_MS) return "degraded";
  return "ok";
}

const STATE_DOT_CLASS: Record<HealthState, string> = {
  unknown: "bg-zinc-300",
  ok: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-rose-500",
};

const STATE_LABEL: Record<HealthState, string> = {
  unknown: "Worker: checking…",
  ok: "Worker: healthy",
  degraded: "Worker: degraded",
  down: "Worker: unreachable",
};

/**
 * Top-bar worker status indicator.
 *
 * Polls `/api/worker/health` every 30s while the tab is visible (pauses on
 * `document.hidden` to avoid background traffic) and renders a small colored
 * dot plus a label. Hovering exposes a tooltip with version, uptime,
 * Claude availability, and queue depth.
 */
export function WorkerStatus() {
  const [result, setResult] = useState<HealthResult | null>(null);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const started = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      const res = await fetch("/api/worker/health", {
        method: "GET",
        cache: "no-store",
        signal: ctrl.signal,
      });
      const elapsed =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        worker?: WorkerHealthPayload;
        error?: string;
      } | null;
      if (res.ok && body?.ok && body.worker) {
        setResult({ ok: true, latencyMs: elapsed, worker: body.worker });
      } else {
        setResult({
          ok: false,
          latencyMs: elapsed,
          error: body?.error ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      const elapsed =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
      setResult({
        ok: false,
        latencyMs: elapsed,
        error: err instanceof Error ? err.message : "Network error",
      });
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let mounted = true;

    function start() {
      if (timer) return;
      // Run an immediate refresh, then poll on the interval.
      if (mounted) void refresh();
      timer = setInterval(() => {
        if (mounted) void refresh();
      }, POLL_INTERVAL_MS);
    }
    function stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    function onVisibility() {
      if (document.hidden) stop();
      else start();
    }

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      mounted = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      abortRef.current?.abort();
    };
  }, [refresh]);

  const state = deriveState(result);
  const worker = result?.ok ? result.worker : null;
  const queueImage = pickQueueCount(worker?.queue_depth, "image");
  const queueVideo = pickQueueCount(worker?.queue_depth, "video");
  const queueBroll = pickQueueCount(worker?.queue_depth, "broll");
  const queueTotal = pickQueueCount(worker?.queue_depth, "total");

  return (
    <div className="relative">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => void refresh()}
        aria-label={STATE_LABEL[state]}
        className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <span
          aria-hidden="true"
          className={cn(
            "h-2 w-2 rounded-full",
            STATE_DOT_CLASS[state],
            state === "unknown" ? "" : "shadow-[0_0_0_2px_rgba(255,255,255,0.6)]",
          )}
        />
        <span className="hidden sm:inline">Worker</span>
      </button>
      {open ? (
        <div
          role="tooltip"
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border bg-popover p-3 text-xs text-popover-foreground shadow-md"
        >
          <p className="text-sm font-medium text-foreground">{STATE_LABEL[state]}</p>
          {result ? (
            <p className="mt-0.5 text-muted-foreground">
              Latency {Math.round(result.latencyMs)} ms
            </p>
          ) : null}
          {result && !result.ok ? (
            <p className="mt-2 break-words text-rose-600">{result.error}</p>
          ) : null}
          {worker ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="truncate font-mono">{worker.version ?? "—"}</dd>
              <dt className="text-muted-foreground">Uptime</dt>
              <dd>{formatUptime(worker.uptime_seconds)}</dd>
              <dt className="text-muted-foreground">Claude</dt>
              <dd>
                {typeof worker.claude_code_available === "boolean"
                  ? worker.claude_code_available
                    ? "available"
                    : "not available"
                  : "—"}
              </dd>
              <dt className="text-muted-foreground">Queue</dt>
              <dd className="font-mono">
                {queueImage ?? 0}i · {queueVideo ?? 0}v · {queueBroll ?? 0}b
                {typeof queueTotal === "number" ? ` (${queueTotal} total)` : ""}
              </dd>
            </dl>
          ) : null}
          <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            Click to refresh · polls every 30s
          </p>
        </div>
      ) : null}
    </div>
  );
}
