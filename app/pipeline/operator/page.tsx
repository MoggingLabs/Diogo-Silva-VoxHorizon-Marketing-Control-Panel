import Link from "next/link";

import { OperatorConsole } from "@/components/pipeline/OperatorConsole";
import { getOperatorRuns } from "@/lib/operator/console";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Operator Console — VoxHorizon",
};

/**
 * Operator Console (E5.3 / #597).
 *
 * The supervision cockpit's home: the manager hires the operator and supervises
 * its live runs here. SSR-seeds the active operator-driven runs (with status,
 * stage + recent narration), then hands off to the client `OperatorConsole`
 * for realtime updates, the live narration feed, and the per-stage gate
 * call-to-actions. Each gate deep-links to the run detail where the HARD gate
 * lives (decisions never bypass the server-side preconditions).
 */
export default async function OperatorConsolePage() {
  const runs = await getOperatorRuns();

  return (
    <main className="container mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <p className="text-sm text-muted-foreground">
        <Link href="/pipeline" className="underline-offset-4 hover:underline">
          Pipeline
        </Link>{" "}
        / operator
      </p>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Operator Console</h1>
        <p className="text-sm text-muted-foreground">
          Hire the operator and supervise its live runs. Sign off at each stage gate and approve the
          render spend.
        </p>
      </header>

      <OperatorConsole initialRuns={runs} />
    </main>
  );
}
