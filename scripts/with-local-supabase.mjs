#!/usr/bin/env node
/**
 * Run a command against the LOCAL Supabase stack instead of the linked project.
 *
 *   node scripts/with-local-supabase.mjs npm run dev
 *   node scripts/with-local-supabase.mjs npm run db:seed -- --reset-activity
 *
 * ## Why this exists
 *
 * `.env.local` holds the **production** project's URL and keys, because that is
 * what the deployed app and the day-to-day workflow need. So a plain
 * `npm run dev` runs the local code against the production database — which is
 * fine right up until the branch you are working on has a migration that
 * production hasn't got, and then every page using it fails with a PostgREST
 * `PGRST202 Could not find the function` that looks nothing like "wrong
 * database".
 *
 * That is not hypothetical: it is exactly what happened the first time anyone
 * tried M8's dashboard. It is the same footgun as `supabase db push` (remote)
 * vs `supabase db reset` (local), which the M7 benchmark protocol shipped with.
 *
 * Keys are read from `supabase status` rather than hard-coded, so this cannot
 * go stale if the local stack is reconfigured. They are the CLI's well-known
 * development keys — not secrets — but there is still no reason to copy them
 * into the repo by hand.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const [, , ...command] = process.argv;

if (command.length === 0) {
  console.error(
    "usage: node scripts/with-local-supabase.mjs <command> [args...]\n" +
      "e.g.   node scripts/with-local-supabase.mjs npm run dev",
  );
  process.exit(1);
}

/**
 * Docker Desktop on macOS installs its CLI to `~/.docker/bin` and relies on the
 * user's shell profile to add it to PATH. When that hasn't happened, the
 * Supabase CLI reports `docker: command not found` and every local command
 * fails for a reason that has nothing to do with Supabase. Put it back if it is
 * there — this is a dev-convenience script, and the alternative is a confusing
 * failure the first time someone clones the repo.
 */
function withDockerOnPath(env) {
  const onPath = spawnSync("docker", ["--version"], { stdio: "ignore" });
  if (onPath.status === 0) return env;

  const dockerBin = join(homedir(), ".docker", "bin");
  if (!existsSync(join(dockerBin, "docker"))) return env;

  console.log(`→ adding ${dockerBin} to PATH (Docker Desktop CLI)`);
  return { ...env, PATH: `${dockerBin}${delimiter}${env.PATH ?? ""}` };
}

/**
 * Read the local stack's URL and keys.
 *
 * `supabase status -o json` **pretty-prints** across many lines, and may emit a
 * plain-text notice ("Stopped services: [...]") before it. So this slices from
 * the first `{` to the last `}` rather than looking for a single JSON line —
 * the per-line version of this failed on the first real run.
 */
function readLocalStatus(env) {
  const result = spawnSync("npx", ["supabase", "status", "-o", "json"], {
    encoding: "utf8",
    env,
  });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { status: null, text };

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (parsed.API_URL && parsed.ANON_KEY) return { status: parsed, text };
  } catch {
    // Fall through to the diagnostic below.
  }
  return { status: null, text };
}

const baseEnv = withDockerOnPath(process.env);
const { status, text } = readLocalStatus(baseEnv);

if (!status) {
  console.error(
    "Could not read the local Supabase stack.\n\n" +
      "Start it first:\n" +
      "  npx supabase start\n\n" +
      "Then apply migrations and seed it:\n" +
      "  npm run db:reset:local     # local only — `db push` targets PRODUCTION\n" +
      "  npm run db:seed:local\n\n" +
      "It also needs Docker Desktop running.\n\n" +
      "--- what `supabase status` actually said ---\n" +
      text.trim(),
  );
  process.exit(1);
}

const env = {
  ...baseEnv,
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  // Next only reads `.env.local` for keys not already in the environment, and
  // `supabase/seed/run.ts` does the same, so setting these here wins.
  NEXT_PUBLIC_SITE_URL:
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
};

console.log(`→ local Supabase: ${status.API_URL}`);
console.log(`→ ${command.join(" ")}\n`);

const child = spawn(command[0], command.slice(1), { env, stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
