/**
 * M10 — DB-level tests for the append-only `events` log.
 *
 *   npm run db:test:events        # local Supabase only
 *
 * ## Why this is a script and not a Vitest file
 *
 * Everything M10 added lives in SQL: a table, two triggers, and one
 * `record_event` call inside each of the five `security definer` transition
 * functions. There is no TypeScript to unit-test — the behaviour under test is
 * "does Postgres do the right thing", and the only honest way to ask that is to
 * ask Postgres. CI has no database, so this stays out of `vitest run` and is
 * run by hand against the local stack.
 *
 * ## What it refuses to do
 *
 * It refuses to run against anything but localhost, and the refusal is hard
 * rather than a warning (`npm run db:seed` only warns). The reason is specific
 * to this table: `events` is append-only and enforced by a trigger, so rows
 * this script writes could not be deleted afterwards even by the service role.
 * A stray run against production would permanently seed the ml subsystem's
 * training corpus with test data.
 *
 * ## Order matters
 *
 * The backfill reconciliation runs *first*, against whatever the seed left
 * behind. If the live-transition scenarios ran first, their listings would be
 * in the source tables when the backfill went looking, and it would synthesise
 * a second, backfilled event for each of them.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) {
  console.error(
    `Refusing to run against ${url || "<no NEXT_PUBLIC_SUPABASE_URL>"}.\n\n` +
      "`events` is append-only: rows written here cannot be deleted, so this\n" +
      "script only ever runs against the local stack.\n\n" +
      "  npx supabase start\n" +
      "  npm run db:reset:local\n" +
      "  npm run db:seed:local\n" +
      "  npm run db:test:events\n",
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

const DOMAIN = "m10-test.foodforeveryone.invalid";
const DONOR_EMAIL = `donor@${DOMAIN}`;
const RECIPIENT_EMAIL = `recipient@${DOMAIN}`;
const PASSWORD = "m10-events-test-password";

// ---------------------------------------------------------------- assertions

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(
      `  FAIL ${name}${detail === undefined ? "" : `\n         ${JSON.stringify(detail)}`}`,
    );
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

// ---------------------------------------------------------------- helpers

interface EventRow {
  id: number;
  occurred_at: string;
  event_type: string;
  listing_id: string | null;
  claim_id: string | null;
  actor_org_id: string | null;
  payload: Record<string, unknown>;
  schema_version: number;
}

async function eventsFor(listingId: string): Promise<EventRow[]> {
  const { data, error } = await admin
    .from("events")
    .select("*")
    .eq("listing_id", listingId)
    .order("id");
  if (error) throw new Error(`read events: ${error.message}`);
  return (data ?? []) as EventRow[];
}

/**
 * The slice of PostgREST's query builder these tests use. Declaring it
 * structurally keeps the file free of `any` without reaching into
 * postgrest-js's internal generics, which are not part of supabase-js's
 * public surface and change between minor versions.
 */
interface CountQuery extends PromiseLike<{
  count: number | null;
  error: { message: string } | null;
}> {
  eq(column: string, value: unknown): CountQuery;
  not(column: string, operator: string, value: unknown): CountQuery;
}

async function countRows(
  table: string,
  filter: (q: CountQuery) => CountQuery = (q) => q,
): Promise<number> {
  const builder = admin
    .from(table)
    .select("*", { count: "exact", head: true }) as unknown as CountQuery;
  const { count, error } = await filter(builder);
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
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

/** A signed-in client, so RPCs run as `authenticated` — not as service_role. */
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

async function makeOrg(
  email: string,
  name: string,
  type: "donor" | "recipient",
  lng: number,
  lat: number,
): Promise<string> {
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
        type,
        email,
        address: "1 Test Street",
        location: `POINT(${lng} ${lat})`,
      },
      { onConflict: "owner_id" },
    )
    .select("id")
    .single();
  if (orgError)
    throw new Error(`organizations.upsert ${email}: ${orgError.message}`);
  return org.id as string;
}

function hours(n: number): string {
  return new Date(Date.now() + n * 3_600_000).toISOString();
}

async function rpc(
  client: SupabaseClient,
  fn: string,
  args: object,
): Promise<string> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as string;
}

// ---------------------------------------------------------------- the tests

async function testBackfill(): Promise<void> {
  console.log("\nbackfill reconciles against the source rows");

  const { data: inserted, error } = await admin.rpc("backfill_events");
  if (error) throw new Error(`backfill_events: ${error.message}`);
  console.log(`  (backfill_events returned ${inserted})`);

  const backfilled = (type: string) =>
    countRows("events", (q) =>
      q.eq("event_type", type).eq("payload->>backfilled", "true"),
    );

  const listings = await countRows("listings");
  const claims = await countRows("claims");
  const completedClaims = await countRows("claims", (q) =>
    q.eq("status", "completed"),
  );
  const releasedClaims = await countRows("claims", (q) =>
    q.eq("status", "released"),
  );
  const cancelledListings = await countRows("listings", (q) =>
    q.eq("status", "cancelled"),
  );

  eq(
    "one listing_posted per listing",
    await backfilled("listing_posted"),
    listings,
  );
  eq(
    "one listing_claimed per claim",
    await backfilled("listing_claimed"),
    claims,
  );
  eq(
    "one claim_completed per completed claim",
    await backfilled("claim_completed"),
    completedClaims,
  );
  eq(
    "one listing_cancelled per cancelled listing",
    await backfilled("listing_cancelled"),
    cancelledListings,
  );

  // A released claim is either a recipient handing it back (claim_cancelled) or
  // a donor withdrawal that displaced it (folded into listing_cancelled). Every
  // released claim must land in exactly one of the two.
  const displaced = await countRows("events", (q) =>
    q
      .eq("event_type", "listing_cancelled")
      .eq("payload->>backfilled", "true")
      .not("payload->>displaced_claim_id", "is", null),
  );
  eq(
    "released claims split between claim_cancelled and displaced-by-withdrawal",
    (await backfilled("claim_cancelled")) + displaced,
    releasedClaims,
  );

  const { data: second, error: secondError } =
    await admin.rpc("backfill_events");
  if (secondError)
    throw new Error(`backfill_events (2nd): ${secondError.message}`);
  eq("a second run is a no-op", second, 0);
}

/**
 * M14 — `backfill_events_incremental()`.
 *
 * Two properties, and the second is a regression test for a real bug.
 *
 * 1. **Incremental, not all-or-nothing.** M10's `backfill_events()` refuses to
 *    run once any backfilled row exists, so after `--reset-activity` the new
 *    listings got no events at all and the ML batch scorer saw an empty log.
 *
 * 2. **Causal ordering within a shared instant.** M10 ordered the insert by
 *    `occurred_at, event_type`, which is alphabetical: `claim_cancelled` sorts
 *    before `listing_claimed`. A claim created and released at the same
 *    timestamp — which the seed produces — therefore landed in the log as
 *    released-then-claimed, and a replay left the listing `claimed` when it was
 *    really back `open`. Measured cost on a freshly seeded database: one open
 *    listing out of thirteen, silently missing from the batch scorer's
 *    population.
 *
 *    `(occurred_at, id)` is the cursor the ml side replays on, so insertion
 *    order *is* causal order. This asserts it directly: wherever a claim's
 *    `listing_claimed` and `claim_cancelled` share an instant, the claim must
 *    have the lower id.
 */
async function testIncrementalBackfill(): Promise<void> {
  console.log("\nincremental backfill fills gaps and orders causally");

  const { data: noop, error } = await admin.rpc("backfill_events_incremental");
  if (error) throw new Error(`backfill_events_incremental: ${error.message}`);
  eq("a run with nothing missing is a no-op", noop, 0);

  const { data: rows, error: readError } = await admin
    .from("events")
    .select("id, occurred_at, event_type, claim_id")
    .in("event_type", ["listing_claimed", "claim_cancelled"])
    .not("claim_id", "is", null);
  if (readError) throw new Error(`events.select: ${readError.message}`);

  const byClaim = new Map<
    string,
    {
      claimed?: { id: number; at: string };
      cancelled?: { id: number; at: string };
    }
  >();
  for (const row of rows ?? []) {
    const claimId = row.claim_id as string;
    const entry = byClaim.get(claimId) ?? {};
    const slot = { id: row.id as number, at: row.occurred_at as string };
    if (row.event_type === "listing_claimed") entry.claimed = slot;
    else entry.cancelled = slot;
    byClaim.set(claimId, entry);
  }

  let collisions = 0;
  let misordered = 0;
  for (const { claimed, cancelled } of byClaim.values()) {
    if (!claimed || !cancelled) continue;
    if (claimed.at !== cancelled.at) continue;
    collisions++;
    if (claimed.id > cancelled.id) misordered++;
  }

  // Reported rather than required: a seeded database may contain zero
  // same-instant claim/release pairs, and a test that silently asserts nothing
  // is worse than one that says so.
  console.log(`  (${collisions} claim/release pair(s) share an instant)`);
  eq("a claim is never released before it is made", misordered, 0);
}

async function testTransitions(
  donorOrg: string,
  recipientOrg: string,
): Promise<void> {
  const donor = await signedIn(DONOR_EMAIL);
  const recipient = await signedIn(RECIPIENT_EMAIL);

  const post = async (title: string): Promise<string> => {
    const code = await rpc(donor, "create_listing", {
      p_title: title,
      p_quantity: "3 crates",
      p_pickup_start: hours(1),
      p_pickup_end: hours(6),
      p_notes: "ring the side door",
    });
    if (code !== "ok") throw new Error(`create_listing ${title}: ${code}`);
    const { data, error } = await admin
      .from("listings")
      .select("id")
      .eq("organization_id", donorOrg)
      .eq("title", title)
      .single();
    if (error) throw new Error(`find listing ${title}: ${error.message}`);
    return data.id as string;
  };

  // --- listing_posted -------------------------------------------------
  console.log("\ncreate_listing emits exactly one listing_posted");
  const a = await post("M10 A — posted only");
  {
    const rows = await eventsFor(a);
    eq("exactly one event", rows.length, 1);
    const [e] = rows;
    eq("event_type", e.event_type, "listing_posted");
    eq("actor is the donor", e.actor_org_id, donorOrg);
    eq("listing_id", e.listing_id, a);
    eq("claim_id is null", e.claim_id, null);
    eq("schema_version", e.schema_version, 1);
    eq("donor_org_id", e.payload.donor_org_id, donorOrg);
    check(
      "carries the pickup window",
      Boolean(e.payload.pickup_end && e.payload.pickup_start),
    );
    check("carries donor coordinates", typeof e.payload.donor_lat === "number");
    eq(
      "notes_length, not the notes",
      e.payload.notes_length,
      "ring the side door".length,
    );
    check("no raw notes in the payload", !("notes" in e.payload));
    check("not marked backfilled", e.payload.backfilled === undefined);
  }

  // --- listing_claimed + claim_completed -------------------------------
  console.log("\nclaim_listing then complete_listing");
  const b = await post("M10 B — claimed then completed");
  await rpc(recipient, "claim_listing", { p_listing_id: b });
  {
    const rows = await eventsFor(b);
    eq("two events so far", rows.length, 2);
    const e = rows[1];
    eq("event_type", e.event_type, "listing_claimed");
    eq("actor is the recipient", e.actor_org_id, recipientOrg);
    check("claim_id is set", typeof e.claim_id === "string");
    eq("recipient_org_id", e.payload.recipient_org_id, recipientOrg);
    eq("donor_org_id", e.payload.donor_org_id, donorOrg);
    check("distance_km computed", typeof e.payload.distance_km === "number");
  }
  await rpc(donor, "complete_listing", { p_listing_id: b });
  {
    const rows = await eventsFor(b);
    eq("three events", rows.length, 3);
    const e = rows[2];
    eq("event_type", e.event_type, "claim_completed");
    eq("actor is the donor", e.actor_org_id, donorOrg);
    eq("claim_id matches the claim", e.claim_id, rows[1].claim_id);
    eq("recipient_org_id", e.payload.recipient_org_id, recipientOrg);
    check("carries claimed_at", typeof e.payload.claimed_at === "string");
  }

  // --- claim_cancelled --------------------------------------------------
  console.log("\nrelease_claim emits claim_cancelled");
  const c = await post("M10 C — claimed then released");
  await rpc(recipient, "claim_listing", { p_listing_id: c });
  await rpc(recipient, "release_claim", { p_listing_id: c });
  {
    const rows = await eventsFor(c);
    eq("three events", rows.length, 3);
    const e = rows[2];
    eq("event_type", e.event_type, "claim_cancelled");
    eq("actor is the recipient", e.actor_org_id, recipientOrg);
    eq("claim_id matches the claim", e.claim_id, rows[1].claim_id);
    eq("cancelled_by", e.payload.cancelled_by, "recipient");
  }

  // --- listing_cancelled, never claimed ---------------------------------
  console.log(
    "\ncancel_listing on an unclaimed listing — the fifth event type",
  );
  const d = await post("M10 D — withdrawn unclaimed");
  await rpc(donor, "cancel_listing", { p_listing_id: d });
  {
    const rows = await eventsFor(d);
    eq("two events", rows.length, 2);
    const e = rows[1];
    eq("event_type", e.event_type, "listing_cancelled");
    eq("actor is the donor", e.actor_org_id, donorOrg);
    eq("claim_id is null", e.claim_id, null);
    eq("cancelled_by", e.payload.cancelled_by, "donor");
    eq("displaced_claim_id is null", e.payload.displaced_claim_id, null);
    check(
      "no claim_cancelled was emitted",
      rows.every((r) => r.event_type !== "claim_cancelled"),
    );
  }

  // --- listing_cancelled, displacing a claim ----------------------------
  console.log("\ncancel_listing on a claimed listing displaces the claim");
  const e5 = await post("M10 E — withdrawn while claimed");
  await rpc(recipient, "claim_listing", { p_listing_id: e5 });
  await rpc(donor, "cancel_listing", { p_listing_id: e5 });
  {
    const rows = await eventsFor(e5);
    eq("three events", rows.length, 3);
    const e = rows[2];
    eq("event_type", e.event_type, "listing_cancelled");
    eq("actor is the donor", e.actor_org_id, donorOrg);
    eq("claim_id is the displaced claim", e.claim_id, rows[1].claim_id);
    eq("displaced_claim_id", e.payload.displaced_claim_id, rows[1].claim_id);
    eq(
      "displaced_recipient_org_id",
      e.payload.displaced_recipient_org_id,
      recipientOrg,
    );
    check(
      "still no claim_cancelled — one action, one event",
      rows.every((r) => r.event_type !== "claim_cancelled"),
    );
  }
}

async function testAppendOnly(): Promise<void> {
  console.log("\nthe log is append-only");

  const { data: row, error } = await admin
    .from("events")
    .select("id")
    .limit(1)
    .single();
  if (error) throw new Error(`read an event: ${error.message}`);
  const id = row.id as number;

  const update = await admin
    .from("events")
    .update({ actor_org_id: null })
    .eq("id", id);
  check(
    "UPDATE is rejected for the service role",
    update.error !== null,
    update.error?.message,
  );

  const del = await admin.from("events").delete().eq("id", id);
  check(
    "DELETE is rejected for the service role",
    del.error !== null,
    del.error?.message,
  );

  const stillThere = await countRows("events", (q) => q.eq("id", id));
  eq("the row is still there", stillThere, 1);

  const authed = await signedIn(DONOR_EMAIL);
  const read = await authed.from("events").select("id").limit(1);
  check(
    "an authenticated client cannot read the log",
    read.error !== null || (read.data ?? []).length === 0,
    read.error?.message,
  );
  const insert = await authed
    .from("events")
    .insert({ event_type: "listing_posted" });
  check(
    "an authenticated client cannot write to it",
    insert.error !== null,
    insert.error?.message,
  );
}

async function testSurvivesOrgDeletion(donorOrg: string): Promise<void> {
  console.log("\nthe log outlives the rows it describes (no foreign keys)");

  const before = await countRows("events", (q) =>
    q.eq("actor_org_id", donorOrg),
  );
  check("there are events to lose", before > 0, { before });

  // Deleting the auth user cascades to organizations -> listings -> claims. If
  // `events` carried an FK, this would either fail on the append-only trigger
  // or take the log rows with it.
  await deleteTestUsers();

  const listingsLeft = await countRows("listings", (q) =>
    q.eq("organization_id", donorOrg),
  );
  eq("the listings are gone", listingsLeft, 0);

  const after = await countRows("events", (q) =>
    q.eq("actor_org_id", donorOrg),
  );
  eq("the events are not", after, before);
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log(`M10/M14 events tests — ${url}`);

  await deleteTestUsers();
  await testBackfill();
  await testIncrementalBackfill();

  const donorOrg = await makeOrg(
    DONOR_EMAIL,
    "M10 Test Donor",
    "donor",
    -73.9857,
    40.7484,
  );
  const recipientOrg = await makeOrg(
    RECIPIENT_EMAIL,
    "M10 Test Recipient",
    "recipient",
    -73.9772,
    40.7527,
  );

  try {
    await testTransitions(donorOrg, recipientOrg);
    await testAppendOnly();
    await testSurvivesOrgDeletion(donorOrg);
  } finally {
    await deleteTestUsers();
  }

  console.log(
    `\n${passed} passed, ${failures.length} failed` +
      (failures.length ? `\n  ${failures.join("\n  ")}` : ""),
  );
  process.exit(failures.length ? 1 : 0);
}

await main();
