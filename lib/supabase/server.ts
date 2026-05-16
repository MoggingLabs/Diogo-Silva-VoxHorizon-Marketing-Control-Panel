import "server-only";

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

import { cleanEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/types.gen";

/**
 * Supabase client for use in Server Components, Server Actions, and Route
 * Handlers. Wires `next/headers` cookies so auth sessions are read/written
 * via Next.js's cookie API.
 *
 * Each request should call `createClient()` once — never cache the returned
 * client across requests because cookie state is request-scoped.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    cleanEnv("NEXT_PUBLIC_SUPABASE_URL"),
    cleanEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options as CookieOptions);
            }
          } catch {
            // `setAll` is called from Server Components where `cookies()` is
            // read-only. Middleware refreshes the session, so this branch is
            // expected and safe to ignore.
          }
        },
      },
    },
  );
}
