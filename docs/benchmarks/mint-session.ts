/**
 * Mint a real app session cookie for the load test.
 *
 *   node docs/benchmarks/mint-session.mjs > docs/benchmarks/.session.json
 *
 * ## Why this exists
 *
 * `/api/orgs` is authenticated, and the session lives in cookies written by
 * `@supabase/ssr` — not in an `Authorization` header. So k6 needs a cookie, and
 * the obvious approaches are both bad:
 *
 *   - Hand-writing the cookie from a Supabase access token means reproducing
 *     `@supabase/ssr`'s encoding (a `base64-` prefix, chunked across
 *     `.0`/`.1` suffixes past a size limit). That is an internal detail of a
 *     library we don't control, so the benchmark would break on a dependency
 *     bump, silently and at the worst moment.
 *   - Adding a sign-in endpoint to the app means shipping a production surface
 *     that exists only for benchmarking.
 *
 * Instead this asks `@supabase/ssr` itself to serialise the session, using the
 * same `createServerClient` the app uses with a cookie adapter that captures
 * the writes instead of sending them. Whatever encoding the library uses, we
 * get it right by construction, and nothing is added to the app.
 *
 * Reads credentials from `.env.local`; defaults to the published read-only demo
 * account, which is the right one to load test with — it can browse everything
 * and write nothing.
 */

import { readFileSync } from "node:fs";
import { createServerClient } from "@supabase/ssr";

import { DEMO_EMAIL, DEMO_PASSWORD } from "../../lib/demo.ts";

for (const line of readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split("\n")) {
  const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY in .env.local");
  process.exit(1);
}

const email = process.env.BENCHMARK_EMAIL ?? DEMO_EMAIL;
const password = process.env.BENCHMARK_PASSWORD ?? DEMO_PASSWORD;

/** Cookies the library wants to set, captured rather than sent. */
const jar = new Map();

const supabase = createServerClient(url, anonKey, {
  cookies: {
    getAll: () =>
      [...jar.entries()].map(([name, value]) => ({ name, value })),
    setAll: (cookies) => {
      for (const { name, value } of cookies) jar.set(name, value);
    },
  },
});

const { error } = await supabase.auth.signInWithPassword({ email, password });
if (error) {
  console.error(`Sign-in failed for ${email}: ${error.message}`);
  process.exit(1);
}

if (jar.size === 0) {
  console.error("Signed in but no cookies were written — check @supabase/ssr.");
  process.exit(1);
}

// `name=value; name=value` — the form a Cookie request header takes.
const cookieHeader = [...jar.entries()]
  .map(([name, value]) => `${name}=${value}`)
  .join("; ");

console.error(`Minted a session for ${email} (${jar.size} cookie(s)).`);
console.log(JSON.stringify({ email, cookie: cookieHeader }, null, 2));
