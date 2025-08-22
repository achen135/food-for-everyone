/**
 * M14 — DB-level RLS tests for `public.listing_risk`.
 *
 *   npm run db:test:listing-risk        # local Supabase only
 *
 * ## Why this exists as a script
 *
 * `listing_risk` is written by a Python batch job with the service-role key and
 * read by the app with the anon key under a user's JWT. The thing that decides
 * who may read what is an RLS policy — SQL — so the only honest way to test it
 * is to drive PostgREST as a real signed-in user, exactly as the browser can.
 *
 * This project has been bitten twice by treating an application-side check as a
 * boundary (M2's `profiles.organization_id`, M4's demo account reaching
 * PostgREST directly). `lib/db/listing-risk.ts` has a feature-flag guard in it,
 * and that guard is **UX**: the anon key ships to the browser, so the policy
 * below is the actual fence. Same reasoning as `supabase/tests/events.ts`.
 *
 * ## What the policy is supposed to say
 *
 *   SELECT  authenticated, and only for listings the caller owns
 *   INSERT  nobody (no policy exists)
 *   UPDATE  nobody
 *   DELETE  nobody
 *
 * The batch job writes with the service-role key, which is not subject to RLS.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) {
  console.error(
    `Refusing to run against ${url || "<no NEXT_PUBLIC_SUPABASE_URL>"}.\n` +
      "This script creates accounts and listings; local stack only.\n\n" +
      "  npm run db:reset:local && npm run db:seed:local\n" +
      "  npm run db:test:listing-risk\n",
  );
  process.exit(1);
}
if (!serviceKey || !anonKey) {
  console.error(
    "Missing SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY.",
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DOMAIN = "m14-test.foodforeveryone.invalid";
const OWNER_EMAIL = `owner@${DOMAIN}`;
const OTHER_EMAIL = `other@${DOMAIN}`;
const PASSWORD = "m14-listing-risk-test-password";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(
      `  FAIL ${name}${detail ? ` — ${JSON.stringify(detail)}` : ""}`,
    );
  }
}

async function deleteTestUsers(): Promise<void> {
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw new Error(`listUsers: ${error.message}`);
    for (const user of data.users) {
      if (user.email?.endsWith(`@${DOMAIN}`)) {
        await admin.auth.admin.deleteUser(user.id);
      }
    }
    if (data.users.length < 200) return;
  }
}

async function signedIn(email: string): Promise<SupabaseClient> {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (error) throw new Error(`signIn ${email}: ${error.message}`);
  return client;
}

async function makeDonor(email: string, name: string): Promise<string> {
  const { data: created, error: userError } = await admin.auth.admin.createUser(
    {
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: name },
    },
  );
  if (userError) throw new Error(`createUser ${email}: ${userError.message}`);

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .upsert(
      {
        owner_id: created.user.id,
        name,
        type: "donor",
        email,
        address: "1 Test Street",
        location: "POINT(-87.63 41.88)",
      },
      { onConflict: "owner_id" },
    )
    .select("id")
    .single();
  if (orgError) throw new Error(`organizations.upsert: ${orgError.message}`);
  return org.id as string;
}

async function makeListing(orgId: string, title: string): Promise<string> {
  const now = Date.now();
  const { data, error } = await admin
    .from("listings")
    .insert({
      organization_id: orgId,
      title,
      quantity: "3 trays",
      pickup_start: new Date(now + 3_600_000).toISOString(),
      pickup_end: new Date(now + 18_000_000).toISOString(),
      status: "open",
    })
    .select("id")
    .single();
  if (error) throw new Error(`listings.insert: ${error.message}`);
  return data.id as string;
}

async function main(): Promise<void> {
  console.log(`M14 listing_risk RLS tests — ${url}`);
  await deleteTestUsers();

  const ownerOrg = await makeDonor(OWNER_EMAIL, "M14 Owner");
  const otherOrg = await makeDonor(OTHER_EMAIL, "M14 Other");

  try {
    const ownedListing = await makeListing(ownerOrg, "Owned listing");
    const otherListing = await makeListing(otherOrg, "Someone else's listing");

    // The batch job's write, simulated: service role, bypassing RLS.
    const { error: writeError } = await admin.from("listing_risk").upsert(
      [
        {
          listing_id: ownedListing,
          risk_tier: "high",
          score: 0.9,
          model_version: "m14-rls-test",
          scored_at: new Date().toISOString(),
        },
        {
          listing_id: otherListing,
          risk_tier: "high",
          score: 0.9,
          model_version: "m14-rls-test",
          scored_at: new Date().toISOString(),
        },
      ],
      { onConflict: "listing_id" },
    );
    check(
      "the service role can write (the batch job's path)",
      !writeError,
      writeError,
    );

    console.log("\nreads are scoped to the caller's own listings");
    const owner = await signedIn(OWNER_EMAIL);

    const { data: mine } = await owner
      .from("listing_risk")
      .select("listing_id, risk_tier")
      .eq("listing_id", ownedListing);
    check(
      "a donor reads the risk of a listing they own",
      (mine ?? []).length === 1,
      mine,
    );

    const { data: theirs } = await owner
      .from("listing_risk")
      .select("listing_id")
      .eq("listing_id", otherListing);
    check(
      "a donor cannot read the risk of someone else's listing",
      (theirs ?? []).length === 0,
      theirs,
    );

    // The query the app actually makes — `.in(...)` over the listings on screen.
    // RLS filters rather than errors, which is what makes the silent fallback
    // in lib/db/listing-risk.ts correct rather than lucky.
    const { data: batched, error: batchError } = await owner
      .from("listing_risk")
      .select("listing_id")
      .in("listing_id", [ownedListing, otherListing]);
    check(
      "a batched read returns only the owned row",
      (batched ?? []).length === 1,
      batched,
    );
    check(
      "and does not error on the filtered-out row",
      !batchError,
      batchError,
    );

    console.log("\nwrites are denied to signed-in users");
    const { error: insertError } = await owner.from("listing_risk").insert({
      listing_id: ownedListing,
      risk_tier: "low",
      score: 0.01,
      model_version: "forged",
      scored_at: new Date().toISOString(),
    });
    check(
      "INSERT is rejected even on a listing they own",
      insertError !== null,
    );

    const { error: updateError, count: updated } = await owner
      .from("listing_risk")
      .update({ risk_tier: "low" }, { count: "exact" })
      .eq("listing_id", ownedListing);
    check("UPDATE changes nothing", updateError !== null || updated === 0, {
      updateError,
      updated,
    });

    const { error: deleteError, count: deleted } = await owner
      .from("listing_risk")
      .delete({ count: "exact" })
      .eq("listing_id", ownedListing);
    check("DELETE removes nothing", deleteError !== null || deleted === 0, {
      deleteError,
      deleted,
    });

    // Prove the row survived the three attempts above.
    const { data: after } = await admin
      .from("listing_risk")
      .select("risk_tier")
      .eq("listing_id", ownedListing)
      .single();
    check(
      "the row is untouched afterwards",
      after?.risk_tier === "high",
      after,
    );

    console.log("\nanon has no access at all");
    const anon = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: anonRows } = await anon
      .from("listing_risk")
      .select("listing_id");
    check(
      "an anonymous client reads nothing",
      (anonRows ?? []).length === 0,
      anonRows,
    );
  } finally {
    await admin
      .from("listing_risk")
      .delete()
      .eq("model_version", "m14-rls-test");
    await deleteTestUsers();
  }

  console.log(
    `\n${passed} passed, ${failures.length} failed` +
      (failures.length ? `\n  ${failures.join("\n  ")}` : ""),
  );
  process.exit(failures.length ? 1 : 0);
}

await main();
