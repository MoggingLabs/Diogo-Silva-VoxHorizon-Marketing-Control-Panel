import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/supabase/types.gen";

/**
 * @deprecated Do not use. Phase 2 of the Supabase RLS lockdown removed every
 * production consumer of this client.
 *
 * The public anon key now has zero useful database access: RLS is enabled
 * deny-all on every public table, so this client returns no rows, cannot
 * write, and cannot receive Realtime `postgres_changes`. All dashboard data
 * flows through the Next.js server (service-role) behind Caddy basic auth:
 *  - reads → `app/api/**` route handlers + server components (`lib/supabase/server.ts`)
 *  - Realtime → the SSE relay (`app/api/realtime/route.ts` + `hooks/useRealtimeStream.ts`)
 *  - storage signed URLs → `app/api/storage/sign`
 *
 * Kept only so historical references/tests resolve; safe to delete once no
 * test imports it.
 */
export function createClient() {
  return createBrowserClient<Database>(
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim(),
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim(),
  );
}
