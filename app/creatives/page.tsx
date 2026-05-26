import { CreativesGrid } from "@/components/creative/CreativesGrid";
import { buildCreativeRows } from "@/lib/creatives-rows";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Creatives — VoxHorizon",
};

/**
 * Unified Creatives index (M4 / #593): one section over both image
 * (`creatives`) and video (`video_creatives`) creatives. Renders a thumbnail
 * grid + DataTable view with a format tab, status filter, search, sort, an
 * active/archived toggle, and per-creative manage + archive/restore actions.
 *
 * The active set is built server-side (signs image thumbnails + resolves brief
 * labels via the shared `buildCreativeRows` helper); the Archived view is
 * fetched on demand by the client from `/api/creatives/archived`.
 */
export default async function CreativesIndexPage() {
  const admin = createAdminClient();
  const { rows, error } = await buildCreativeRows(admin, { archived: false });

  return (
    <main className="container mx-auto flex min-h-dvh flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Creatives</h1>
        <p className="text-sm text-muted-foreground">
          Every image + video variant the pipeline produced. Open one to review, edit, decide, or
          archive.
        </p>
      </header>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Failed to load creatives: {error}
        </div>
      ) : null}

      <CreativesGrid initialRows={rows} />
    </main>
  );
}
