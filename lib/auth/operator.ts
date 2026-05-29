import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The single operator row, narrowed to the columns the login flow reads.
 *
 * `operators` is a 0057 table that may not be in `lib/supabase/types.gen.ts`
 * yet (the types regen lives in a sibling track), so the query is cast through
 * `as never` at the table name and the result shape is asserted here. This
 * mirrors how the e2e specs read other not-yet-regenerated tables
 * (`creative_stage_state`, `compliance_finding`).
 */
export type OperatorRow = {
  id: string;
  email: string;
  password_hash: string;
};

/**
 * Look up the operator by email (case-insensitive). Returns the row or `null`
 * when no operator matches. Uses the service-role admin client because
 * `operators` is RLS deny-all (migration 0057) — only the trusted server may
 * read the password hash.
 *
 * The email is lowercased before the lookup; the row is stored lowercased by
 * the seed recipe (see .env.example), so this is an exact-match read on the
 * unique `email` column.
 */
export async function findOperatorByEmail(email: string): Promise<OperatorRow | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("operators" as never)
    .select("id, email, password_hash")
    .eq("email" as never, normalized as never)
    .maybeSingle();

  if (error) {
    throw new Error(`findOperatorByEmail failed: ${error.message}`);
  }
  return (data as OperatorRow | null) ?? null;
}
