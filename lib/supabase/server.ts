import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { cleanEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/types.gen";

/**
 * Supabase client for Server Components, Server Actions, and Route Handlers.
 *
 * SECURITY (Phase 2 — RLS lockdown): this client authenticates with the
 * service-role credential (`SUPABASE_SECRET_KEY`), NOT the public anon key.
 *
 * Why service-role here is correct and safe:
 *  - Every public table now has RLS enabled with NO policies (deny-all). The
 *    anon role can no longer read anything, so the old anon-keyed server
 *    client would return empty results for every page read.
 *  - There is no Supabase Auth in this deployment — no end-user JWTs — so
 *    there is no per-user RLS context to honour. The only legitimate database
 *    client is the trusted server.
 *  - This module is `server-only`: importing it from a client component fails
 *    the build, so the service-role key can never reach the browser. The
 *    dashboard itself sits behind Caddy HTTP Basic Auth, so every request
 *    that reaches a server component is already authenticated at the edge.
 *
 * The `service_role` Postgres role has `rolbypassrls = true`, so reads here
 * bypass RLS and keep working exactly as before the lockdown.
 *
 * The function stays `async` and keeps the same call signature
 * (`await createClient()`) as the previous cookie-based implementation so no
 * caller needs to change. Cookie plumbing was removed: there is no Supabase
 * session to read/write, and `middleware.ts` does not depend on it (it is a
 * pure Tailscale IP gate).
 */
export async function createClient() {
  return createSupabaseClient<Database>(
    cleanEnv("NEXT_PUBLIC_SUPABASE_URL"),
    cleanEnv("SUPABASE_SECRET_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
}
