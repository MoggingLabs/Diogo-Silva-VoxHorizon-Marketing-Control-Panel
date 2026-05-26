import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CopyManager, type ManagedCopyVariant } from "@/components/copy/CopyManager";
import { copyTableFor, type CopyFormatT } from "@/lib/copy/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Copy variants — VoxHorizon",
};

type SearchParams = { creative_id?: string; format?: string };

/**
 * Standalone copy editor page (E3.3 / #592).
 *
 * Reachable from a creative / brief via `?creative_id=<uuid>&format=image|video`.
 * Manages `copy_variants` / `video_copy_variants` for one creative outside the
 * pipeline copy stage: list + create + edit + archive + restore. The detail
 * pages can link here ("Manage copy"); the M4 creatives surface can embed
 * `<CopyManager />` directly.
 */
export default async function CopyPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { creative_id: creativeId, format: formatParam } = await searchParams;
  const format: CopyFormatT = formatParam === "video" ? "video" : "image";

  if (!creativeId) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Missing <code className="font-mono">creative_id</code>. Open the copy editor from a
          creative.
        </p>
      </main>
    );
  }

  const supabase = await createClient();
  const creativeTable = format === "video" ? "video_creatives" : "creatives";

  const [creativeRes, variantsRes] = await Promise.all([
    supabase.from(creativeTable).select("id, brief_id").eq("id", creativeId).maybeSingle(),
    supabase
      .from(copyTableFor(format))
      .select("*")
      .eq("creative_id", creativeId)
      .order("variant_index", { ascending: true })
      .limit(200),
  ]);

  if (creativeRes.error) throw new Error(creativeRes.error.message);
  if (!creativeRes.data) notFound();

  const briefId = (creativeRes.data as { brief_id: string | null }).brief_id;
  // Runtime-built path: typedRoutes can't statically verify the interpolation,
  // so cast to Route (same pattern as DataTable's URL-state writer).
  const briefHref: Route | null = briefId
    ? ((format === "video" ? `/briefs/video/${briefId}` : `/briefs/${briefId}`) as Route)
    : null;

  const variants: ManagedCopyVariant[] = (variantsRes.data ?? []).map((v) => {
    const row = v as Record<string, unknown>;
    return {
      id: String(row.id),
      platform: String(row.platform ?? "meta"),
      variant_index: Number(row.variant_index ?? 0),
      headline: (row.headline as string | null) ?? null,
      body: (row.body as string | null) ?? null,
      description: (row.description as string | null) ?? null,
      cta: (row.cta as string | null) ?? null,
      status: (row.status as string | null) ?? null,
      deleted_at: (row.deleted_at as string | null) ?? null,
    };
  });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">
          <Link href="/briefs" className="underline-offset-4 hover:underline">
            Briefs
          </Link>
          {briefHref ? (
            <>
              {" "}
              /{" "}
              <Link href={briefHref} className="underline-offset-4 hover:underline">
                Brief
              </Link>
            </>
          ) : null}{" "}
          / <span className="capitalize">{format} copy</span>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Copy variants</h1>
        <p className="text-sm text-muted-foreground">
          Manage the copy for this {format} creative outside the pipeline.
        </p>
      </header>

      {variantsRes.error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Failed to load copy: {variantsRes.error.message}
        </div>
      ) : null}

      <CopyManager format={format} creativeId={creativeId} variants={variants} />
    </main>
  );
}
