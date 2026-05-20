import Link from "next/link";

import { OperatorKickoffForm } from "@/components/pipeline/OperatorKickoffForm";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Hire the operator — VoxHorizon",
};

/**
 * Operator-driven kickoff page. Hosts the free-text brief form that creates a
 * pipeline and dispatches the Hermes operator (`POST /api/pipelines/operator`),
 * then redirects to the new pipeline's supervision view. This is the
 * supervision cockpit's entry point — the manager hires the operator here and
 * supervises the run from the detail page.
 */
export default function OperatorKickoffPage() {
  return (
    <main className="container mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <p className="text-sm text-muted-foreground">
        <Link href="/pipeline" className="underline-offset-4 hover:underline">
          Pipeline
        </Link>{" "}
        / operator
      </p>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Operator pipeline</h1>
        <p className="text-sm text-muted-foreground">
          Kick off a run the operator drives end-to-end. You stay the supervisor: sign off at each
          stage gate and approve the render spend.
        </p>
      </header>

      <OperatorKickoffForm />
    </main>
  );
}
