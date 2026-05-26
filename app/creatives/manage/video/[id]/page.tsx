import { notFound } from "next/navigation";

import { VideoCreativeManage } from "@/components/creative/VideoCreativeManage";
import { getSignedUrl, type VideoCreative } from "@/lib/video-creatives";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  return { title: `Manage video creative ${id.slice(0, 8)} — VoxHorizon` };
}

type Row = Record<string, unknown> & { id: string };

/**
 * Per-creative manage surface for a video creative (E4.2 / #594). Mirrors the
 * image manage page: metadata edit (asset name), the approve/reject decision
 * (existing video decision route — the ONLY way status changes), the iteration
 * thread (existing video iterations route), the copy variants, read-only gate
 * artifacts, and soft-delete + restore.
 *
 * The preview is the captioned MP4 (falls back to the composed cut), signed
 * server-side from the private `creatives` bucket.
 */
export default async function ManageVideoCreativePage({ params }: PageProps) {
  const { id } = await params;
  const admin = createAdminClient();

  const { data: creative, error } = await admin
    .from("video_creatives")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!creative) notFound();

  const typed = creative as VideoCreative;
  const previewPath = typed.captioned_path ?? typed.composed_path ?? null;

  const [briefRes, copyRes, qaRes, specRes, complianceRes, stageRes, signedUrl] = await Promise.all(
    [
      admin
        .from("video_briefs")
        .select("id, brief_id_human, status, client_id")
        .eq("id", typed.brief_id)
        .maybeSingle(),
      admin
        .from("video_copy_variants")
        .select("*")
        .eq("creative_id", id)
        .order("created_at", { ascending: true })
        .limit(200),
      admin
        .from("qa_result")
        .select("id, attempt, status, defects, created_at")
        .eq("creative_id", id)
        .order("attempt", { ascending: false })
        .limit(20),
      admin
        .from("spec_check")
        .select("id, platform, placement, ratio, status")
        .eq("creative_id", id)
        .limit(50),
      admin
        .from("compliance_finding")
        .select("id, rule_id, severity, verdict, overridden, required_edit")
        .eq("creative_id", id)
        .limit(100),
      admin
        .from("creative_stage_state")
        .select("id, stage, status, decided_at")
        .eq("creative_id", id)
        .limit(50),
      getSignedUrl(admin, previewPath),
    ],
  );

  return (
    <VideoCreativeManage
      creative={typed}
      brief={
        (briefRes.data as {
          id: string;
          brief_id_human: string;
          status: string;
          client_id: string | null;
        } | null) ?? null
      }
      signedUrl={signedUrl}
      copyVariants={(copyRes.data ?? []) as Row[]}
      qa={(qaRes.data ?? []) as Row[]}
      spec={(specRes.data ?? []) as Row[]}
      compliance={(complianceRes.data ?? []) as Row[]}
      stageState={(stageRes.data ?? []) as Row[]}
    />
  );
}
