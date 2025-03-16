/**
 * Environment access. Values are read lazily (inside functions), never at module
 * load, so `next build` / CI don't fail when Supabase env is absent — see
 * Spec §10. A missing value throws only when something actually needs it.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/** Supabase project URL. Safe to expose to the browser. */
export function supabaseUrl(): string {
  return required("NEXT_PUBLIC_SUPABASE_URL");
}

/** Supabase anon (publishable) key. Safe to expose to the browser; RLS still applies. */
export function supabaseAnonKey(): string {
  return required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

/**
 * Absolute origin used to build auth email / OAuth redirect URLs.
 * Resolution order:
 *   1. NEXT_PUBLIC_SITE_URL — set this only to override (e.g. a custom domain).
 *   2. VERCEL_PROJECT_PRODUCTION_URL — injected by Vercel in every environment,
 *      so preview + production work with no config.
 *   3. http://localhost:3000 — local dev.
 */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;

  return "http://localhost:3000";
}
