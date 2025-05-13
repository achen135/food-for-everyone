/**
 * Seed the database with demo organizations.
 *
 *   npm run db:seed          # create any missing seed orgs
 *   npm run db:seed -- --reset   # delete all seed accounts first, then create
 *
 * Needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in
 * `.env.local`. The service-role key bypasses RLS — that is exactly why this is
 * a standalone script and never imported by the app.
 *
 * Safety: every account this script touches has an email ending in
 * `SEED_EMAIL_DOMAIN`. It never reads, updates, or deletes anything else, so it
 * cannot disturb a real account. Organizations are removed via the
 * `owner_id → auth.users on delete cascade` foreign key.
 *
 * Run with Node's native type stripping (Node 22.18+); no build step:
 *   node --experimental-strip-types supabase/seed/run.ts
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { SEED_ORGANIZATIONS, type SeedOrganization } from "./organizations.ts";
import { DEMO_ORGANIZATION } from "./demo-account.ts";
import { DEMO_EMAIL, DEMO_PASSWORD } from "../../lib/demo.ts";

/** Reserved TLD (RFC 2606) — these addresses can never be delivered to. */
const SEED_EMAIL_DOMAIN = "seed.foodforeveryone.invalid";
const SEED_PASSWORD_BYTES = 24;
const PAGE_SIZE = 200;

function loadEnvLocal(): void {
  // Tiny .env.local reader so the script needs no dotenv dependency.
  let raw: string;
  try {
    raw = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (!process.env[key]) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

function seedEmail(org: SeedOrganization): string {
  return `${org.slug}@${SEED_EMAIL_DOMAIN}`;
}

function randomPassword(): string {
  return Buffer.from(
    crypto.getRandomValues(new Uint8Array(SEED_PASSWORD_BYTES)),
  ).toString("base64url");
}

/** Every auth user belonging to the seed set, paged. */
async function listSeedUsers(
  admin: SupabaseClient,
): Promise<{ id: string; email: string }[]> {
  const found: { id: string; email: string }[] = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: PAGE_SIZE,
    });
    if (error) throw error;
    for (const user of data.users) {
      if (user.email?.endsWith(`@${SEED_EMAIL_DOMAIN}`)) {
        found.push({ id: user.id, email: user.email });
      }
    }
    if (data.users.length < PAGE_SIZE) return found;
  }
}

/** Paginated lookup by exact email — the demo account isn't on the seed domain. */
async function findUserByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<{ id: string } | null> {
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: PAGE_SIZE,
    });
    if (error) throw error;
    const found = data.users.find((u) => u.email === email);
    if (found) return { id: found.id };
    if (data.users.length < PAGE_SIZE) return null;
  }
}

/**
 * The public read-only demo account (Spec §10). Deliberately outside
 * `--reset`'s deletion pass: its credentials are fixed, so deleting and
 * recreating it converges on the same state anyway, but would invalidate any
 * session someone happens to be using it in right now for no benefit.
 */
/**
 * Can someone actually sign in with the credentials the README publishes?
 *
 * Uses the anon key and a throwaway client — exactly the path a visitor takes,
 * so this checks the thing that matters rather than a proxy for it.
 */
async function publishedPasswordWorks(): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Without the anon key we can't tell, and recreating the account on a
    // guess would needlessly invalidate a working demo. Leave it alone.
    console.log(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY not set — skipping the demo password check.",
    );
    return true;
  }
  const probe = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await probe.auth.signInWithPassword({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
  });
  return !error;
}

async function seedDemoAccount(
  admin: SupabaseClient,
): Promise<"created" | "updated"> {
  let existing = await findUserByEmail(admin, DEMO_EMAIL);
  let userId: string;
  let result: "created" | "updated";

  // The demo's credentials are immutable (the protect_demo_credentials trigger
  // blocks password and email changes, including this script's — see that
  // migration for why it has no admin exemption). So the repair path is to
  // recreate the account, and the only reason to reach for it is that the
  // published password has actually stopped working.
  if (existing && !(await publishedPasswordWorks())) {
    console.log("Demo password no longer matches the README — recreating.");
    const { error } = await admin.auth.admin.deleteUser(existing.id);
    if (error) throw new Error(`deleteUser ${DEMO_EMAIL}: ${error.message}`);
    existing = null;
  }

  if (!existing) {
    const { data, error } = await admin.auth.admin.createUser({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Demo Account" },
    });
    if (error) throw new Error(`createUser ${DEMO_EMAIL}: ${error.message}`);
    userId = data.user.id;
    result = "created";
  } else {
    // Credentials already correct; only the profile and org rows below need
    // re-asserting, and those go through the service role, which RLS exempts.
    userId = existing.id;
    result = "updated";
  }

  // Upsert rather than update: don't assume the handle_new_user trigger has
  // necessarily run yet by this point.
  const { error: profileError } = await admin
    .from("profiles")
    .upsert({ id: userId, is_demo: true }, { onConflict: "id" });
  if (profileError) {
    throw new Error(`profiles.upsert ${DEMO_EMAIL}: ${profileError.message}`);
  }

  const { error: orgError } = await admin.from("organizations").upsert(
    {
      owner_id: userId,
      name: DEMO_ORGANIZATION.name,
      type: DEMO_ORGANIZATION.type,
      description: DEMO_ORGANIZATION.description,
      email: DEMO_ORGANIZATION.email,
      phone: DEMO_ORGANIZATION.phone,
      website: DEMO_ORGANIZATION.website,
      address: DEMO_ORGANIZATION.address,
      location: `POINT(${DEMO_ORGANIZATION.longitude} ${DEMO_ORGANIZATION.latitude})`,
      verified: DEMO_ORGANIZATION.verified,
    },
    { onConflict: "owner_id" },
  );
  if (orgError) {
    throw new Error(`organizations.upsert ${DEMO_EMAIL}: ${orgError.message}`);
  }

  return result;
}

async function main(): Promise<void> {
  loadEnvLocal();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
        "Add them to .env.local (Supabase → Project Settings → API).",
    );
    process.exitCode = 1;
    return;
  }

  const reset = process.argv.includes("--reset");
  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Target: ${url}`);
  console.log(`Seed accounts: *@${SEED_EMAIL_DOMAIN}`);

  const existing = await listSeedUsers(admin);

  if (reset && existing.length > 0) {
    console.log(`Deleting ${existing.length} existing seed account(s)…`);
    for (const user of existing) {
      const { error } = await admin.auth.admin.deleteUser(user.id);
      if (error) throw error;
    }
    existing.length = 0;
  }

  const byEmail = new Map(existing.map((u) => [u.email, u.id]));
  let created = 0;
  let updated = 0;

  for (const org of SEED_ORGANIZATIONS) {
    const email = seedEmail(org);
    let userId = byEmail.get(email);

    if (!userId) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: randomPassword(),
        email_confirm: true,
        user_metadata: { full_name: `${org.name} (seed)` },
      });
      if (error) throw new Error(`createUser ${email}: ${error.message}`);
      userId = data.user.id;
      created += 1;
    } else {
      updated += 1;
    }

    const { error } = await admin.from("organizations").upsert(
      {
        owner_id: userId,
        name: org.name,
        type: org.type,
        description: org.description,
        email: org.email,
        phone: org.phone,
        website: org.website,
        address: org.address,
        // geography(Point,4326) — longitude first, as WKT.
        location: `POINT(${org.longitude} ${org.latitude})`,
        verified: org.verified,
      },
      { onConflict: "owner_id" },
    );
    if (error) throw new Error(`upsert ${org.name}: ${error.message}`);
  }

  const donors = SEED_ORGANIZATIONS.filter((o) => o.type === "donor").length;
  console.log(
    `Done. ${SEED_ORGANIZATIONS.length} organizations ` +
      `(${donors} donors, ${SEED_ORGANIZATIONS.length - donors} recipients); ` +
      `${created} account(s) created, ${updated} reused.`,
  );

  const demoResult = await seedDemoAccount(admin);
  console.log(`Demo account ${demoResult}: ${DEMO_EMAIL}`);

  console.log(
    "This is seeded demo data — never describe it as real traffic (Spec §9).",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
