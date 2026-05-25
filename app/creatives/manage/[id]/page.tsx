import { notFound } from "next/navigation";

import { CreativeManage } from "@/components/creative/CreativeManage";
import { getSignedUrl, type Creative } from "@/lib/creatives";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  return { title: `Manage creative ${id.slice(0, 8)} — VoxHorizon` };
}

type CopyVariant = Record<string, unknown> & { id: string };

/**
 * Per-creative manage surface for an image creative (E4.2 / #594).
 *
 * One page that lets the operator: edit the safe metadata (PATCH), take the
 * approve/reject decision (existing decision route), read the iteration thread
 * (existing iterations route), read the copy variants, and read the gate
 * artifacts (QA / spec / compliance / stage state) which mutate only through
 * their pipeline-scoped decision/override routes — surfaced read-only with a
 * link back to the pipeline review surface. Soft-delete + restore live here too.
 *
 * Data is read server-side via the admin client (storage signing needs the
 * privileged key) and handed to the client component.
 */
export default async function ManageCreativePage({ params }: PageProps) {
  const { id } = await params;
  const admin = createAdminClient();

  const { data: creative, error } = await admin
    .from("creatives")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!creative) notFound();

  const typed = creative as Creative;

  const [briefRes, copyRes, qaRes, specRes, complianceRes, stageRes, signedUrl] = await Promise.all(
    [
      admin
        .from("briefs")
        .select("id, brief_id_human, status, client_id")
        .eq("id", typed.brief_id)
        .maybeSingle(),
      admin
        .from("copy_variants")
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
      getSignedUrl(admin, typed.file_path_supabase),
    ],
  );

  return (
    <CreativeManage
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
      copyVariants={(copyRes.data ?? []) as CopyVariant[]}
      qa={(qaRes.data ?? []) as Array<Record<string, unknown> & { id: string }>}
      spec={(specRes.data ?? []) as Array<Record<string, unknown> & { id: string }>}
      compliance={(complianceRes.data ?? []) as Array<Record<string, unknown> & { id: string }>}
      stageState={(stageRes.data ?? []) as Array<Record<string, unknown> & { id: string }>}
    />
  );
}
