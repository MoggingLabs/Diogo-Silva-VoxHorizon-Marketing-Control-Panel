import Link from "next/link";

import { BriefForm } from "@/components/brief/BriefForm";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "New image brief — VoxHorizon",
};

export default function NewBriefPage() {
  return (
    <main className="container mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href="/briefs" className="underline-offset-4 hover:underline">
              Briefs
            </Link>{" "}
            / new
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            New image brief
          </h1>
        </div>
      </header>
      <p className="text-sm text-muted-foreground sm:text-base">
        Save as draft to keep iterating, or post for approval to move it into the queue.
      </p>
      <BriefForm />
    </main>
  );
}
