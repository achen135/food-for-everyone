import { createBrowserClient } from "@supabase/ssr";

import { supabaseAnonKey, supabaseUrl } from "@/lib/env";

/**
 * Supabase client for Client Components (runs in the browser).
 * Only ever uses the anon key; every read/write is still subject to RLS.
 */
export function createClient() {
  return createBrowserClient(supabaseUrl(), supabaseAnonKey());
}
