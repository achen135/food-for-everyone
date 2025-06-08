# Benchmarks

Evidence for the M7 performance-layer claims (Spec §9).

## Result — measured 2026-09-02

Run under the [Protocol](#protocol) below: local Supabase in Docker, `next start`,
4 VUs / 30 s, rate limiter off in both legs, one build shared by both. Both legs
happened to complete exactly 740 requests, so the read counts compare directly.

| | cache off | cache on | delta |
|---|---|---|---|
| requests | 740 | 740 | — |
| **DB reads** | **740** | **10** | **98.6% fewer** |
| p50 | 60.54 ms | 57.73 ms | 4.7% faster |
| p95 | 71.02 ms | 82.09 ms | **15.6% slower** |
| mean | 62.11 ms | 61.31 ms | 1.3% faster |

Cache internals on the treatment leg: 707 hits, 20 stale hits, 10 misses,
23 coalesced, 0 evictions, 5 resident keys.

**The read reduction is real and large. The latency improvement is not there,
and p95 got worse.** That is not a defect in the cache — it is what the numbers
say about where the time goes, and the explanation is in the cross-check below:
`organizations_near` has a mean execution time of **0.72 ms**. Caching a
sub-millisecond query cannot move a ~60 ms request. The request is dominated by
two GoTrue round-trips (~14 ms each — the middleware and the route handler each
call `getUser()`), plus framework overhead. The database was never the
bottleneck on this endpoint.

The p95 regression is the cost side of the same trade: stale-while-revalidate
does background refresh work, and coalescing makes a few unlucky requests wait
on a shared in-flight fetch. With nothing to win on the read path, only that
cost shows up in the tail.

**What may be cited from this run:** the read reduction, with the setup named.
**What may not:** any "p50 A ms → B ms" latency claim. Spec §9's rule applies to
its own author — the number did not come out of the protocol, so it does not go
on the résumé. See [Interpretation](#interpretation) at the end.

## What is being measured, and why those two things

**Database reads.** The claim is "fewer reads", so the counter has to sit where
every read passes: `tracked()` in `lib/db/instrument.ts`. Every data-layer
function wraps its query in it, so a read that isn't counted is a read that
didn't happen through the data layer — which would itself be a bug.

**Latency (p50/p95), under load.** A single request timed by hand mostly
measures the network. What the cache changes is behaviour *under concurrency* —
particularly the stampede, where N simultaneous readers of a cold key become
either N queries or one. That only shows up with concurrent virtual users.

## Prerequisites

Neither is installed on the machine this was written on; both are free.

| | Why | Install |
|---|---|---|
| **Docker Desktop** | `supabase start` runs the full local stack — Postgres with PostGIS, GoTrue, PostgREST. Needed because the schema depends on `auth.users` and `auth.uid()`, which a bare Postgres won't have. | [docker.com](https://www.docker.com/products/docker-desktop/) |
| **k6** | The load generator. | `brew install k6` |

Both were installed for the 2026-09-02 run (Docker Desktop 29.7.2, k6 v2.2.0).
Docker is a dependency of the *measurement* only — the app itself has no
Dockerfile and is not containerised anywhere.

Run against **local** Postgres, never the deployed app: Vercel's fair-use policy
forbids load testing, Hobby has no SLA, and latency to a remote Supabase is
dominated by the network — which is the thing we are not trying to measure.

## Protocol

Both legs run the same binary and the same script. **Exactly one variable
changes between them.** If anything else differs, the delta isn't attributable
to the cache and the number is worthless.

```bash
# 0. Local stack, migrations, demo data
supabase start
supabase db reset      # NOT `db push` — this repo is linked, and `db push`
                       # targets the remote production project. `db reset`
                       # replays every migration into the local container.
npm run db:seed        # check its first line reads `Target: http://127.0.0.1:54321`

# Point .env.local at the local stack for the duration of the run
#   NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
#   come from `supabase status`.

# 1. Build once — both legs must run the same artifact
npm run build

# 2. A real session cookie for k6
# .session.json holds a live access + refresh token — it is gitignored, and
# should stay that way.
node --experimental-strip-types docs/benchmarks/mint-session.ts \
  > docs/benchmarks/.session.json
COOKIE=$(node -e "console.log(require('./docs/benchmarks/.session.json').cookie)")
```

The rate limiter is **off** for both legs. Spec §9 is explicit about this: a
limiter that starts rejecting requests suppresses reads, and the read reduction
would then partly measure the limiter rather than the cache.

```bash
# 3. Control — cache off
CACHE_DISABLED=1 RATE_LIMIT_DISABLED=1 BENCHMARK_MODE=1 npm start &
curl -X DELETE localhost:3000/api/benchmark          # zero the counters
k6 run -e COOKIE="$COOKIE" --summary-export=docs/benchmarks/results-cache-off.json \
  docs/benchmarks/orgs-map.js
curl -s localhost:3000/api/benchmark | tee docs/benchmarks/reads-cache-off.json
kill %1

# 4. Treatment — cache on. Nothing else changes.
RATE_LIMIT_DISABLED=1 BENCHMARK_MODE=1 npm start &
curl -X DELETE localhost:3000/api/benchmark
k6 run -e COOKIE="$COOKIE" --summary-export=docs/benchmarks/results-cache-on.json \
  docs/benchmarks/orgs-map.js
curl -s localhost:3000/api/benchmark | tee docs/benchmarks/reads-cache-on.json
kill %1
```

Then commit all four JSON files, and write the figures into `docs/Sessions.md`
alongside the date and the machine they came from.

`% fewer reads = (before − after) / before`, taken from the two `reads-*.json`
files. p50/p95 come from `http_req_duration` in the two k6 summaries.

### Cross-check the read counter

Our counter is application-side, so it should be confirmed against the database
rather than trusted:

```sql
create extension if not exists pg_stat_statements;
select pg_stat_statements_reset();
-- run one leg --
select calls, query from pg_stat_statements
where query ilike '%organizations_near%' order by calls desc;
```

If `calls` and `dbReads` disagree, the application counter is wrong — treat the
database as the source of truth and fix `tracked()`.

### Things that would invalidate a run

- Different code between legs (rebuild once, before both).
- The rate limiter on — 429s suppress reads and truncate the latency tail.
- A warm cache at the start of the treatment leg (`DELETE /api/benchmark`
  clears entries as well as counters).
- A different seed dataset between legs — re-run `npm run db:seed` only before
  both, never between them.
- Anything else heavy on the machine. Note what else was running.

## Correctness check (*not* the benchmark)

Run on 2026-09-02 against the app on `next start`, talking to the **remote**
Supabase project. Eight identical `GET /api/orgs` requests, rate limiter off:

| Cache | DB reads | Cache hits |
|---|---|---|
| disabled | 8 | 0 |
| enabled | 1 | 7 |

The rate limiter was checked separately: 40 rapid requests against a capacity of
30 gave 33 × `200` and 7 × `429`, with correct `RateLimit-*` and `Retry-After`
headers. (33 rather than 30 because the bucket refilled ~3 tokens during the
~6 s the loop took — the refill working, not an off-by-three.)

**This is a functional check that the mechanisms do what they claim, on a
synthetic repeat-identical-request pattern. It is not a performance result and
must not be quoted as one.** Real traffic does not repeat one request eight
times; a hit rate measured that way is an artefact of the test, not a property
of the system. The figure that can be cited comes from the protocol above, with
its realistic viewport mix, under concurrency, against a local database.

## Files

| File | |
|---|---|
| `orgs-map.js` | The k6 script. Identical across both legs — that is the point. |
| `mint-session.ts` | Mints a real app session cookie for k6. See the header for why it exists rather than hand-writing one. |
| `results-cache-{off,on}.json` | k6 summaries, 2026-09-02 run. |
| `reads-cache-{off,on}.json` | Read counters, 2026-09-02 run. |

`orgs-map.js` has now been executed. One change was needed on first run: the VU
count dropped from 10 to 4. See the comment in the script — above ~25 req/s the
local GoTrue container exhausts ephemeral ports to Postgres, 500s, and the app
surfaces that as 401. At 10 VUs, 22% of requests failed that way and the run was
discarded. 4 VUs sustains 0% errors.

## Interpretation

Three things this run established, in descending order of how much they matter:

1. **The read-through cache removes 98.6% of database reads on the map query.**
   Verified twice — application counter and `pg_stat_statements` agreed exactly.
2. **The map endpoint is auth-bound, not database-bound.** Every authenticated
   request costs two GoTrue round-trips because the middleware and the route
   handler each call `getUser()`. That is ~28 ms against a 0.72 ms query. If
   latency on this endpoint is ever the goal, that is the thing to attack —
   caching the query was optimising the cheap half.
3. **A closed-loop `constant-vus` executor makes read counts sensitive to
   throughput.** It happened to be harmless here (both legs landed on 740
   requests), but a faster leg does more iterations and therefore more reads,
   which understates the reduction. A `constant-arrival-rate` executor would fix
   the comparison by construction and is the recommended change before any
   re-run.
