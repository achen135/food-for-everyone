/**
 * Assert that `NEXT_PUBLIC_*` really reached the browser bundle.
 *
 * Next inlines those variables into client code by *substituting the text*
 * `process.env.NEXT_PUBLIC_FOO` with a literal — a browser has no `process` to
 * read at runtime. So any indirection defeats it:
 *
 *   process.env[name]                  // computed key — never substituted
 *   const e = process.env; e.NEXT_...  // aliased — never substituted
 *
 * The failure is silent and one-sided: the value is still present on the
 * server, so pages render, `next build` passes, and every test passes. It only
 * surfaces when a Client Component actually reads it in the browser. That
 * shipped here undetected from M1 until M6 (Sessions, 2026-08-31).
 *
 * This runs after `next build` and greps the emitted client chunks for the
 * value that was supposed to be baked in. Run it with the same env the build
 * used; in CI that's the placeholder values in ci.yml.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const STATIC_DIR = join(process.cwd(), ".next", "static");

/** Vars that must be visible to client code, and why. */
const REQUIRED_IN_CLIENT = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".js")) yield full;
  }
}

const missingEnv = REQUIRED_IN_CLIENT.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.log(
    `[client-env] skipped — ${missingEnv.join(", ")} not set in this shell, ` +
      `so there is nothing to look for. Run after a build that had them.`,
  );
  process.exit(0);
}

const chunks = [];
for await (const file of walk(STATIC_DIR)) chunks.push(file);

if (chunks.length === 0) {
  console.error(
    "[client-env] no client chunks found — run `next build` first.",
  );
  process.exit(1);
}

const haystack = (
  await Promise.all(chunks.map((f) => readFile(f, "utf8")))
).join("\n");

const missing = REQUIRED_IN_CLIENT.filter(
  (name) => !haystack.includes(process.env[name]),
);

if (missing.length > 0) {
  console.error(
    `[client-env] FAIL — these never made it into the browser bundle:\n` +
      missing.map((n) => `  - ${n}`).join("\n") +
      `\n\nThey are almost certainly being read indirectly. Reference them as\n` +
      `  process.env.${missing[0]}\n` +
      `exactly — a computed or aliased access cannot be substituted, and fails\n` +
      `silently in the browser while still working on the server.`,
  );
  process.exit(1);
}

console.log(
  `[client-env] ok — ${REQUIRED_IN_CLIENT.length} public vars present in the client bundle`,
);
