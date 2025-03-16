import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { supabaseAnonKey, supabaseUrl } from "@/lib/env";

/**
 * Supabase client for Server Components, Server Actions, and Route Handlers.
 * The session lives in cookies; `@supabase/ssr` reads and (where allowed)
 * rewrites them. Must be created per-request — never hoist to module scope.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `setAll` was called from a Server Component, where cookies are
          // read-only. Safe to ignore: middleware refreshes the session cookie
          // on every request (see lib/supabase/middleware.ts).
        }
      },
    },
  });
}
