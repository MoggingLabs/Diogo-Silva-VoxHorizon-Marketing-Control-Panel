import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/supabase/types.gen";

/**
 * Supabase client for use in Client Components.
 *
 * Reads the public Supabase URL + anon key from `NEXT_PUBLIC_*` env vars at
 * build time. Safe to call from anywhere on the client. RLS still enforces
 * access — the anon key alone grants no privileges beyond what policies allow.
 */
export function createClient() {
  return createBrowserClient<Database>(
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim(),
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim(),
  );
}
