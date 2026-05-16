import { headers } from "next/headers";
import { Bell } from "lucide-react";

import { Button } from "@/components/ui/button";
import { worker, WorkerError, type WorkerHealth } from "@/lib/worker";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settings — VoxHorizon",
};

type HealthCheck =
  | { ok: true; latencyMs: number; data: WorkerHealth }
  | { ok: false; latencyMs: number; error: string };

async function probeWorker(): Promise<HealthCheck> {
  const started = Date.now();
  try {
    const data = await worker.health();
    return { ok: true, latencyMs: Date.now() - started, data };
  } catch (err) {
    const message =
      err instanceof WorkerError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unknown worker error";
    return { ok: false, latencyMs: Date.now() - started, error: message };
  }
}

function maskWorkerUrl(raw: string | undefined): string {
  if (!raw) return "(unset)";
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw;
  }
}

function formatUptime(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${s}s`;
}

/**
 * /settings — read-only operations page.
 *
 * Surfaces the configured worker URL (sanitized), live worker health, the
 * placeholder cron/notification surfaces, and basic app/server metadata.
 * Theme is hard-coded to light for v1; dark mode lands later.
 *
 * Implements M5-5 (#68).
 */
export default async function SettingsPage() {
  const hdrs = await headers();
  const requestedHost = hdrs.get("host") ?? "(unknown)";
  const requestedProto = hdrs.get("x-forwarded-proto") ?? "https";

  const workerUrl = maskWorkerUrl(process.env.WORKER_URL?.trim() || undefined);
  const workerProbe = await probeWorker();
  const appVersion =
    process.env.NEXT_PUBLIC_APP_VERSION?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    "dev";
  const buildTime =
    process.env.NEXT_PUBLIC_BUILD_TIME?.trim() ||
    process.env.VERCEL_DEPLOYMENT_CREATED_AT?.trim() ||
    "(unknown — set NEXT_PUBLIC_BUILD_TIME at build)";
  const nodeEnv = process.env.NODE_ENV ?? "(unknown)";

  return (
    <main className="container mx-auto flex min-h-dvh max-w-3xl flex-col gap-8 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Operational status and configuration. Read-only in v1.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Worker connection</h2>
        <dl className="grid grid-cols-[10rem_1fr] items-baseline gap-x-4 gap-y-2 rounded-md border bg-background p-4 text-sm">
          <dt className="text-muted-foreground">URL</dt>
          <dd className="break-all font-mono text-xs">{workerUrl}</dd>

          <dt className="text-muted-foreground">Status</dt>
          <dd>
            {workerProbe.ok ? (
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                <span>Healthy</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-rose-500" aria-hidden="true" />
                <span>Unreachable</span>
              </span>
            )}
          </dd>

          <dt className="text-muted-foreground">Latency</dt>
          <dd className="font-mono text-xs">{workerProbe.latencyMs} ms</dd>

          {workerProbe.ok ? (
            <>
              <dt className="text-muted-foreground">Service</dt>
              <dd className="font-mono text-xs">{workerProbe.data.service ?? "—"}</dd>
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-mono text-xs">{workerProbe.data.version ?? "—"}</dd>
              <dt className="text-muted-foreground">Uptime</dt>
              <dd>{formatUptime(workerProbe.data.uptime_seconds)}</dd>
            </>
          ) : (
            <>
              <dt className="text-muted-foreground">Error</dt>
              <dd className="break-words text-rose-600">{workerProbe.error}</dd>
            </>
          )}
        </dl>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Scheduled jobs</h2>
        <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
          <p>
            Cron jobs are configured in <span className="font-mono">worker/scheduling/</span>. A
            live UI listing for next/last run lands with <span className="font-mono">M4-8</span> —
            not yet shipped.
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Notifications</h2>
        <div className="flex flex-col gap-3 rounded-md border bg-background p-4 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <Bell className="mt-0.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <div className="flex flex-col gap-1">
                <p className="font-medium">Push notifications</p>
                <p className="text-xs text-muted-foreground">
                  Get notified when a brief moves through approval, a launch is created, or a worker
                  job fails. Subscription handling lands in <span className="font-mono">M4-11</span>
                  .
                </p>
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" disabled>
              Enable push notifications
            </Button>
          </div>
          <p
            role="note"
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          >
            Push subscription wiring ships in M4-11. This button will activate once the backend is
            ready.
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Appearance</h2>
        <dl className="grid grid-cols-[10rem_1fr] items-baseline gap-x-4 gap-y-2 rounded-md border bg-background p-4 text-sm">
          <dt className="text-muted-foreground">Theme</dt>
          <dd>Light (only theme in v1)</dd>
        </dl>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">App</h2>
        <dl className="grid grid-cols-[10rem_1fr] items-baseline gap-x-4 gap-y-2 rounded-md border bg-background p-4 text-sm">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="font-mono text-xs">{appVersion}</dd>
          <dt className="text-muted-foreground">Build</dt>
          <dd className="font-mono text-xs">{buildTime}</dd>
          <dt className="text-muted-foreground">Environment</dt>
          <dd className="font-mono text-xs">{nodeEnv}</dd>
          <dt className="text-muted-foreground">Host</dt>
          <dd className="break-all font-mono text-xs">
            {requestedProto}://{requestedHost}
          </dd>
        </dl>
      </section>
    </main>
  );
}
