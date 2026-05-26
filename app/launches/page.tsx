import { LaunchesManager } from "@/components/launch/LaunchesManager";
import type { LaunchListRow } from "@/lib/launches/client";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Launches — VoxHorizon",
};

const SELECT = "id, brief_id, status, created_at, decided_at, decided_notes, payload, deleted_at";

/**
 * Unified Launches section (E5.1 / #595).
 *
 * SSR-seeds the active image + video launch packages, then hands off to the
 * client `LaunchesManager` for the format tab, sort/filter, archive/restore and
 * bulk archive. Archived sets are fetched lazily client-side when that view
 * opens, so the first paint stays cheap.
 */
export default async function LaunchesIndexPage() {
  const supabase = await createClient();

  const [imageRes, videoRes] = await Promise.all([
    supabase
      .from("launch_packages")
      .select(SELECT)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("video_launch_packages")
      .select(SELECT)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const initialImage = (imageRes.data ?? []) as unknown as LaunchListRow[];
  const initialVideo = (videoRes.data ?? []) as unknown as LaunchListRow[];

  return <LaunchesManager initialImage={initialImage} initialVideo={initialVideo} />;
}
