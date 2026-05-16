import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { cleanEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/types.gen";

/**
 * Service-role Supabase client. Bypasses RLS entirely — use only for trusted
 * server-side workflows (worker callbacks, admin jobs, migrations).
 *
 * Marked `server-only` so any accidental import from a client component will
 * fail the build instead of leaking the service-role key to the browser.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    cleanEnv("NEXT_PUBLIC_SUPABASE_URL"),
    cleanEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
}
