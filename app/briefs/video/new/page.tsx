import Link from "next/link";

import { VideoBriefForm } from "@/components/brief/VideoBriefForm";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * /briefs/video/new — composer for a new video brief.
 *
 * Pre-loads the active clients server-side so the form's client picker
 * doesn't need a separate round trip. Inactive clients are filtered out.
 *
 * Implements V1-2 (#79).
 */
export default async function NewVideoBriefPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, slug, status")
    .order("name", { ascending: true });

  const clients = (data ?? [])
    .filter((c) => c.status === "active")
    .map(({ id, name, slug }) => ({ id, name, slug }));

  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 py-12">
      <header className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">New video brief</h1>
          <p className="text-sm text-muted-foreground">
            Draft a short-form video brief: hook, segment breakdown, voice, and style.
          </p>
        </div>
        <Link href="/briefs/video" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to video briefs
        </Link>
      </header>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          Failed to load clients: {error.message}
        </div>
      )}

      {clients.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No active clients yet. Add one before posting a brief.
        </p>
      ) : (
        <VideoBriefForm clients={clients} />
      )}
    </main>
  );
}
