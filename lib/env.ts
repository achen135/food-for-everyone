/**
 * Environment access.
 *
 * Two rules here, both load-bearing:
 *
 * 1. **Read inside functions, never at module load**, so `next build` and CI
 *    don't fail when Supabase env is absent (Spec §10). A missing value throws
 *    only when something actually needs it.
 *
 * 2. **Reference `process.env.NEXT_PUBLIC_*` statically.** Next replaces those
 *    expressions with literals when it builds the client bundle — it is text
 *    substitution, not a runtime lookup, because a browser has no `process`.
 *    A computed access like `process.env[name]` cannot be substituted, so it
 *    silently becomes `undefined` in the browser while continuing to work on
 *    the server. That was a real bug here (see Sessions, 2026-08-31): it hid
 *    until the first Client Component built a Supabase client during render.
 *    `scripts/check-client-env.mjs` guards against it coming back.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/** Supabase project URL. Safe to expose to the browser. */
export function supabaseUrl(): string {
  return required(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
}

/** Supabase anon (publishable) key. Safe to expose to the browser; RLS still applies. */
export function supabaseAnonKey(): string {
  return required(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
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

/**
 * Whether to surface ML waste-risk tiers on the listings page (M14).
 *
 * Server-only and read **inside a function**, per rule 1 above — the flag must
 * not be inlined into the client bundle, and a missing value must not throw.
 * Deliberately *not* `NEXT_PUBLIC_*`: the risk tier reaches the browser as
 * rendered markup, and whether the feature is on is not the browser's business.
 *
 * Off unless explicitly enabled. Everything downstream falls back silently to
 * the pre-M14 render, so "unset" and "the batch job has never run" look the
 * same to a user, which is the intent — see `lib/db/listing-risk.ts`.
 */
export function mlRiskEscalationEnabled(): boolean {
  const raw = process.env.ML_RISK_ESCALATION;
  return raw === "1" || raw?.toLowerCase() === "true";
}
