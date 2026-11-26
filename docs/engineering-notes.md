# Engineering notes

How OpenLecture got from a course prototype to its current state: what was
wrong, how each problem was found, how each fix works and why it was chosen,
what went wrong along the way, and what's left. Numbers are summarised here;
[`results.md`](results.md) has every measurement with its command and raw data,
and [`capacity.md`](capacity.md) has the sizing.

- [Timeline](#timeline)
- [Starting point](#starting-point)
- [The changes](#the-changes)
- [How the Q&A system works now](#how-the-qa-system-works-now)
- [How things were verified](#how-things-were-verified)
- [Mistakes and lessons](#mistakes-and-lessons)
- [Future work](#future-work)

## Timeline

The course version (Team 43) ended in April 2026. Everything below came after.

| Date | Commit | Change |
|---|---|---|
| 2026-10-08 | `4666a36` | Stop tracking `.env`; add `.env.example` templates |
| 2026-10-08 | `58af0ec` | Allocate WebRTC slots atomically in Redis |
| 2026-10-08 | `02bfa9b` | `/stream/end`: reject instructors who don't own the lecture |
| 2026-10-08 | `f6a005d` | Make Q&A room lifecycle and ranking work across instances |
| 2026-10-08 | `aa94dd9` | Cache HLS segments, keep playlists uncached |
| 2026-10-08 | `dc08277` | k6 STRESS mode |
| 2026-10-20 | `d1213a7` | P0: run DB migrations on startup; baseline measurements |
| 2026-10-21 | `682f6d3` | P1: Q&A WebSocket load test; sequence numbers and ACKs |
| 2026-10-26 | `35f91a6` | P2a: coalesce broadcasts across instances |
| 2026-10-26 | `9e6df61` | P2b: bounded payload, Redis ranking indexes, atomic votes |
| 2026-10-26 | `ff9b7b8` | P3: enrollment checks, one-time WebSocket tickets |
| 2026-10-26 | `dda30ce` | P4: crash-safe presence, AOF, incremental flush, failover |
| 2026-10-27 | `4402db2` | P5: capacity estimate |
| 2026-10-27 | `2951cd1` | P6: Prometheus metrics, Grafana profile |
| 2026-10-27 | `11d3b01` | P7: README, repo layout, dead code removed |
| 2026-10-29 | `fbfe39d` | Hardening: input limits, rate limits, resync, crash fix |
| 2026-10-30 | `2f2cbbf` | Hardening results and known limitations documented |

## Starting point

The course version worked in a demo but had never been measured. A review
found:

- **A committed secret.** The LiveKit API key and secret were in `.env` in git.
  Untracking the file doesn't remove it from history; the key must be revoked.
- **A race on WebRTC slots.** Join read LiveKit's participant count, then issued
  a token: check-then-act. 1,000 simultaneous joins all saw "under 500" and all
  got WebRTC. It also made a LiveKit API call on every join.
- **An ignored ownership check.** `/stream/end` ran an update filtered by owner,
  then ignored the result, so any instructor could end any lecture.
- **Q&A broken with more than one instance.** Cleanup ran when *one* instance's
  room emptied and deleted the shared Redis buffer while other instances still
  had students. The ranking strategy lived in process memory, so instances
  disagreed. Every instance flushed every lecture every 5 s.
- **HLS caching that would defeat a CDN.** Everything under `/hls/` was
  `no-cache`, segments included.
- **A load test that measured itself.** The reported 33 req/s was set by the
  script's sleep time; server CPU was near 0 %.
- **Q&A had never been load-tested** (the test made no WebSocket connections).
- **No database migrations ran in Docker** (found in P0), so a fresh
  `docker compose up` had no tables.

## The changes

Each change followed the same loop: measure, find the cause, make the smallest
fix, prove it with a check that fails on the old code, measure again with the
same workload, one commit.

### Atomic WebRTC slots (`58af0ec`)

**Problem.** Check-then-act on the participant count (above).

**Design.** A Redis sorted set per lecture (`stream:webrtc:<id>`, member = user
id, score = time). A Lua script does "if this user has a slot, keep it; else if
fewer than the limit, add them" as one atomic step. Rejoining reuses the slot,
`/stream/leave` frees it, and slots whose owners never showed up in LiveKit are
reconciled, but only when the lecture is full and at most every 15 s.

**Rejected.** A Postgres row lock (a database lock on the hottest path); a
distributed lock around read-then-write (two round trips, expiry edge cases); an
in-memory counter (wrong with more than one instance).

**Result.** 1,000 simultaneous joins on 3 instances: exactly 500 WebRTC, 500 HLS,
0 failures (re-verified on the final code, [results](results.md)).

### Q&A across instances (`f6a005d`)

The lecture-wide connection count, the ranking strategy and a per-lecture flush
lock (`SET NX PX`) moved into Redis. The connection count was later replaced by
crash-safe per-instance presence (P4).

### P0: a reproducible baseline (`d1213a7`)

core-api now runs the migration before starting, under a Postgres advisory lock
so scaled replicas don't race. Baseline: the HTTP path (join, polls, catalog)
handled 1,125 req/s with 0 errors and a p95 of 5 ms, far from saturated. That
pointed the work at the untested Q&A path.

### P1: measuring Q&A (`682f6d3`)

**What was built.** `globalclass/k6/qa_ws_test.js`: N students on one lecture,
5 % asking, the rest upvoting, measured over a steady 120 s window.

**Exact latency.** A broadcast doesn't know which vote caused it, so every
change now bumps a per-lecture version (`qa:ver`), every update carries it as
`seq`, and the sender gets `ACK {seq}`. Latency = send → first update with
`seq` ≥ the ACK's.

**Bug fixed on the way.** The WebSocket handler attached its listeners after
three `await`s, so early messages were dropped and an early close skipped the
connection-count decrement. Listeners are now attached synchronously and wait
on a setup promise.

**Finding.** Every change broadcast the full list to every client: cost grew
with viewers × changes × list size. At 200 viewers, 21 changes/s became 21.4
messages/s per viewer (~80 MB/s total). At 500 viewers egress reached 433 MB/s
and the test machine couldn't sustain it.

### P2a: coalesced broadcasts (`35f91a6`)

**Goal.** At most one broadcast per lecture per 250 ms across all instances,
without ever ending on a stale list.

**Design.** A per-lecture Redis lease (`qa:bcast`) plus the version counter. See
[the broadcast protocol](#broadcast-protocol) for the steps and the argument
for why the last change can't be lost. Code: `backend/src/services/broadcaster.js`.

**Rejected.** Per-instance debounce (every instance still broadcasts); a
dedicated broadcaster service (a new single point of failure); trailing-only
debounce (delays every lone change and never fires under constant voting);
Redis Streams (more parts, no correctness gain).

**Trade-off.** Under steady voting each change waits for the current window:
p95 went from 20 ms to ~250 ms. A lone change still goes out in ~27 ms.

**Result.** ~4 messages/s per viewer at any change rate (21 → 107/s tested);
−83 % bytes per viewer at 200 viewers; 500 and 1,000 viewers now sustainable.

### P2b: bounded payload and Redis ranking (`9e6df61`)

**Problem.** Even at 4/s, each update was the whole list (270 KB at 1,000
questions), built by fetching and sorting everything.

**Design.**
- Updates carry the top 50 open questions, the 20 latest answered, and counts.
  The full list stays available over REST.
- Ranking lives in sorted sets, one per index, kept current by the vote and
  answer scripts; a broadcast reads K entries (O(log N + K)).
- Members are `created_at|id`. Redis orders equal scores by member, so ties
  break by time exactly. `votes` and `default` read differently scored sets to
  get oldest-first vs newest-first ties.
- The Strategy pattern stays: each strategy has an in-memory comparator (for
  Postgres reads) and a live index; `scripts/ranking-check.js` proves they agree.
- Vote and mark-answered became single Lua scripts.

**Bug fixed.** A vote for a nonexistent question used to be buffered; its
foreign key then failed the whole flush transaction, and that lecture never
persisted again. The vote script now rejects unknown questions.

**Rejected.** Deltas (smallest messages, but per-client state and resync logic).

**Result.** Update size 270 KB → 13.7 KB for a 1,000-question lecture; egress
531 → 28 MB/s at 500 viewers. Combined with P2a: −88 % bytes per viewer.

### P3: access control (`ff9b7b8`)

**Problems.** Any logged-in user could watch any lecture or join its Q&A; any
instructor could moderate any lecture; the browser sent its JWT in the
WebSocket URL, and nginx's access log held 8,060 of them.

**Design.**
- `/stream/join` checks enrollment inside the query it already ran (an `EXISTS`
  on the enrollments index): no extra round trip.
- WebSocket [tickets](#tickets-and-access-cache): `POST /api/qa/ticket` → 32
  random bytes, 30 s, single use via `GETDEL`.
- Moderation requires the lecture's own instructor (`isOwner` in the ticket).
- REST question routes follow the same rules and now broadcast.

**Rejected.** JWT in `Sec-WebSocket-Protocol` (a hack some proxies log);
cookies (CSRF and cross-origin work in the dev setup); caching negative
enrollment answers (would lock out newly enrolled students).

**Result.** A 23-case access matrix passes; join median 3.52 → 3.58 ms; ticket
median 2.4 ms.

### P4: durability and failure (`dda30ce`)

**Problems.**
1. Redis had no persistence, yet Q&A writes live only in Redis for up to 5 s.
2. Presence was one lecture-wide counter. A killed instance never decremented
   it, so the lecture never looked empty, the final flush never ran, and the
   last seconds of Q&A never reached Postgres.
3. Every flush re-wrote every question and vote, row by row.
4. Clients gave up after 8 reconnect attempts and retried in lockstep.
5. nginx waited its default 60 s to connect to a dead instance.

**Design.**
- Redis AOF with `appendfsync everysec`.
- [Per-instance presence with heartbeats](#presence-and-cleanup) and a sweeper
  over all live lectures.
- [Incremental, crash-safe flush](#flush-protocol).
- Server ping every 30 s; clients reconnect with full jitter, no attempt limit.
- nginx `proxy_connect_timeout 2s` + `proxy_next_upstream error timeout`.

**Result.** Redis SIGKILL: 0 → 10,000 of 10,000 writes kept. Instance killed,
then everyone leaves within ~1.5 s: 0 of 120 → 110 of 110 acknowledged writes in
Postgres. Instance killed under 1,000 viewers: all 332 dropped sockets back
within 1.0 s, 14,179 of 14,179 acknowledged writes kept. Postgres CPU 14 % →
1.2 %.

### P5: capacity (`4402db2`)

New measured unit costs (11 Redis commands per vote, 3.4 MB per large lecture,
~100 KB per socket), used to size a 10,000-viewer lecture in
[`capacity.md`](capacity.md). Main finding: Q&A egress is still ~4.4 Gbps,
about 30 % of the video bandwidth.

### P6: observability (`2951cd1`)

`prom-client` metrics on both services (`backend/src/metrics.js`,
`streaming-engine/src/metrics.js`), an optional compose profile with Prometheus
(Docker DNS service discovery) and a provisioned Grafana dashboard. `/metrics`
isn't routed through nginx. The client-supplied message type is limited to 4
known labels to bound cardinality. At 1,000 viewers the server's counts matched
k6 within 0.3 %: 104 changes/s in, 3.96 broadcasts/s out.

### P7: presentation (`11d3b01`)

New README, course files moved to `docs/course/` unchanged, dead code removed,
the slot cap re-verified.

### Hardening after review (`fbfe39d`)

A critical review of the finished work found three gaps:
- **Unbounded input.** P2b bounded the number of questions per update, not
  their size, and the WebSocket accepted 100 MiB messages. Now: 1–1,000
  characters, UUID ids, 16 KB bodies, 16 KiB WebSocket messages.
- **No rate limiting.** Now [per account](#rate-limits), not per IP, because
  students behind a campus NAT share one address.
- **At-most-once Pub/Sub.** An instance whose subscriber briefly disconnected
  missed broadcasts, and a quiet lecture stayed stale. On reconnect each
  instance now re-sends the latest snapshot to its sockets. Stale clients under a
  flapping link: 194 of 240 → 0 of 240.

A bug introduced and caught in this round is described under
[mistakes](#mistakes-and-lessons).

## How the Q&A system works now

### Lifecycle of a change

1. Client gets a ticket (`POST /api/qa/ticket`) and connects to
   `/qaws?lectureId=…&ticket=…`.
2. On connect: the ticket is redeemed (`GETDEL`), the socket joins the local
   room, presence is counted, the instance subscribes to the lecture's channel,
   and the client receives the last published snapshot (one `GET`).
3. A change (`SUBMIT_QUESTION`, `VOTE`, `MARK_ANSWERED`, `SET_STRATEGY`) is
   validated and rate-limited, then applied by one Lua script that also records
   it in the dirty sets.
4. `MARK_DIRTY` bumps `qa:ver` and tries to take the broadcast lease; the client
   gets `ACK {seq}`.
5. The lease holder publishes the bounded view; every instance relays it to its
   own sockets.
6. Every 5 s, the flush writes the dirty rows to Postgres.

### Redis keys

| Key | Type | Holds | Lifetime |
|---|---|---|---|
| `qa:live:q:<lecture>` | hash | question id → question JSON | live buffer |
| `qa:live:vc:<lecture>` | hash | question id → vote count | live buffer |
| `qa:live:voted:<lecture>` | hash | `questionId:studentId` → 1 (one vote per student) | live buffer |
| `qa:live:rank:votes:<lecture>` | sorted set | open questions, score = votes (read high→low) | live buffer |
| `qa:live:rank:votesFifo:<lecture>` | sorted set | open questions, score = −votes (read low→high) | live buffer |
| `qa:live:rank:recent:<lecture>` | sorted set | open questions, score 0, ordered by member | live buffer |
| `qa:live:answered:<lecture>` | sorted set | answered questions, score = time answered | live buffer |
| `qa:strategy:<lecture>` | string | active ranking strategy | live buffer |
| `qa:ver:<lecture>` | string | version, `INCR` per change | live buffer |
| `qa:bcast:<lecture>` | string | broadcast lease (instance id) | `PX 2000`, renewed |
| `qa:sent:<lecture>` | string | last published `seq` | live buffer |
| `qa:snapshot:<lecture>` | string | last published update | live buffer |
| `qa:broadcast:<lecture>` | Pub/Sub channel | updates for that lecture | – |
| `qa:dirty:q:<lecture>`, `qa:dirty:v:<lecture>` | set | changed question ids / vote fields since last flush | until flushed |
| `qa:flushing:q:<lecture>`, `qa:flushing:v:<lecture>` | set | the batch a flush is writing | until commit |
| `qa:flushlock:<lecture>` | string | one flusher per lecture per tick | `PX 4000` |
| `qa:conn:<lecture>` | hash | instance id → sockets it holds | live buffer |
| `qa:alive:<instance>` | string | instance heartbeat | `EX 15`, refreshed every 5 s |
| `qa:active` | set | lectures with a live buffer | – |
| `qa:ticket:<ticket>` | string | ticket claims (user, lecture, isOwner) | `EX 30`, single use |
| `lecture:owner:<lecture>` | string | instructor id (access cache) | `EX` 12 h |
| `lecture:enrolled:<lecture>` | set | enrolled student ids (positive cache) | `EX` 12 h |
| `rl:<kind>:<who>` | string | rate-limit counter for a window | window length |
| `stream:webrtc:<lecture>` | sorted set | WebRTC slots, score = time claimed | 6 h safety TTL |
| `stream:reconcile:<lecture>` | string | throttles slot reconciliation | `EX 15` |

The "live buffer" keys are deleted together, by one Lua script, when the lecture
empties and its final flush has succeeded.

### Broadcast protocol

Code: `backend/src/services/broadcaster.js`.

1. A change writes its data, then runs `MARK_DIRTY`: `INCR qa:ver` and
   `SET qa:bcast <instance> NX PX 2000`, atomically.
2. If it got the lease, that instance publishes immediately (leading edge).
3. The holder loop: read `qa:ver`, build the view, then `PUBLISH_IF_LEASED`, a
   script that publishes only if this instance still holds the lease and `seq`
   is newer than `qa:sent`. Wait 250 ms.
4. `RELEASE_OR_CONTINUE`: if `qa:ver` hasn't moved, delete the lease; otherwise
   extend it and go back to step 3 (trailing edge).
5. A sweeper on every instance with sockets in the lecture runs every second: if
   `qa:ver > qa:sent` and the lease is free (a holder crashed and its lease
   expired), it takes the lease.

**Why the last change is never dropped.** Step 1's increment and lease grab are
one atomic script. For any change M: if the lease was free, M takes it and
publishes. If it was held, the holder's step-4 check runs either after M's
increment (it sees the version moved and publishes again) or before it (the
lease is already gone, so M's grab succeeds). Redis runs scripts one at a time,
so there is no third case.

**Hand-off race.** A loop that has just released the lease may still be exiting
when a new change on the same instance takes the lease. The new change sees "a
loop is running" and would do nothing. A re-run flag makes the exiting loop go
round once more. `scripts/coalesce-check.js` forces this timing: 2,769 ms
without the flag (recovered only by lease expiry), 125 ms with it.

**Ordering.** Only the lease holder publishes, and the publish script refuses
any `seq` ≤ `qa:sent`. Clients ignore an update whose `seq` is lower than one
they have (the connect snapshot can race a broadcast in flight).

**Delivery.** Pub/Sub is at-most-once. Because every update is a complete view,
the latest one supersedes any missed; each instance re-sends `qa:snapshot` to
its sockets when its subscriber reconnects.

### Flush protocol

Code: `flushToDB` in `backend/src/services/qaService.js`.

1. `TAKE_DIRTY` atomically merges the dirty sets into the flushing sets, clears
   the dirty sets, and returns the flushing sets' members. Leftovers from a
   flush that died are included again.
2. Read those questions from the live hash; write questions, then votes, each as
   one multi-row `INSERT … SELECT * FROM unnest(…) ON CONFLICT …`, in one
   transaction.
3. On commit, delete the flushing sets. On failure, put the ids back into the
   dirty sets and throw; the next tick retries.

Upserts are idempotent, so a repeated batch is harmless.

### Presence and cleanup

- Each instance counts its own sockets in `qa:conn:<lecture>` (`HINCRBY`) and
  refreshes `qa:alive:<instance>` (15 s) every 5 s.
- Live count = the sum over instances whose heartbeat key exists.
- On a socket close, if the live count reaches 0, the final flush runs.
- Every 5 s, under the flush lock, each instance walks `qa:active`: it drops
  entries of dead instances, runs the final flush if nobody is left, otherwise
  flushes changes.
- `DELETE_IF_EMPTY` deletes the buffer only if the live count is 0 and nothing
  new is dirty, so a client that joins or votes during cleanup keeps the buffer.

### Tickets and access cache

Code: `backend/src/services/accessService.js`.

Access = the lecture's instructor, or a student enrolled in it. The owner and
enrolled students are cached in Redis; only positive answers are cached, and
enrolling adds the student immediately. A ticket's claims include the user,
the lecture and `isOwner`, so the WebSocket needs no database lookup.

### Rate limits

Code: `backend/src/services/rateLimit.js`. Fixed windows, one Lua call (`INCR`,
`EXPIRE` on first hit), keyed by account:

| What | Limit |
|---|---|
| Questions | 10 per minute per student |
| Votes | 30 per 10 s per student |
| Tickets | 30 per minute per account |
| Failed logins | 10 per 15 min per email (checked before bcrypt) |

Fixed windows allow up to 2× a limit across a window boundary.

### Timing constants

| Constant | Value | Where |
|---|---|---|
| Broadcast window | 250 ms (`QA_BROADCAST_WINDOW_MS`) | `broadcaster.js` |
| Broadcast lease | 2 s, renewed | `broadcaster.js` |
| Lease sweeper | every 1 s | `qaHandler.js` |
| Flush / presence sweep | every 5 s, lock 4 s | `qaHandler.js`, `qaService.js` |
| Heartbeat | refresh 5 s, expiry 15 s | `qaService.js` |
| WebSocket ping | every 30 s | `qaHandler.js` |
| Ticket | 30 s, single use | `accessService.js` |
| Top K | 50 open + 20 answered (`QA_TOP_K`, `QA_ANSWERED_K`) | `qaService.js` |
| WebRTC limit | 500 (`WEBRTC_PRIORITY_LIMIT`) | `tierService.js` |
| Client reconnect | full jitter, base 1 s, cap 30 s | `frontend/src/hooks/useWebSocket.js` |
| nginx connect timeout | 2 s, then next instance | `nginx/nginx.conf` |

## How things were verified

Every fix has a check that fails on the old code and passes on the new one
("negative control"); several were confirmed by building an older commit and
running the same check against it.

| Script | What it proves |
|---|---|
| `backend/scripts/smoke.js` | End-to-end API and Q&A through the gateway, incl. fan-out across instances and data reaching Postgres |
| `backend/scripts/access-check.js` | 23-case access matrix: join, tickets (reuse, expiry, wrong lecture, old JWT scheme), moderation |
| `backend/scripts/abuse-check.js` | Input limits, rate limits, and that every core-api survives an oversized message |
| `backend/scripts/coalesce-check.js` | Broadcaster correctness: storm, window edges, forced hand-off race, crashed lease holder |
| `backend/scripts/ranking-check.js` | Redis top-K == in-memory sort for every strategy; vote edge cases |
| `backend/scripts/resync-check.js` | Clients catch up after a flapping Redis link |
| `backend/scripts/tail-loss-check.js` | No acknowledged write lost when an instance dies and everyone leaves |
| `backend/scripts/slot-check.js` | 1,000 simultaneous joins → exactly the WebRTC limit |
| `backend/scripts/capacity-probe.js` | Redis commands per change; memory per lecture |
| `k6/qa_ws_test.js` + `scripts/run-qa-load.ps1` | Q&A load test: latency, messages, bytes, errors, CPU |
| `scripts/chaos-kill-core.ps1` | The load test with one core-api killed mid-run; ACKs vs Postgres |
| `backend/scripts/prom-report.js` | Server-side metrics for a load-test window |

All measurements ran on one laptop (14 vCPUs, Docker Desktop) with the load
generator on the same machine.

## Mistakes and lessons

- **A safety limit that crashed the server.** Adding `maxPayload` made an
  oversized WebSocket message emit an `error` event that nothing handled, so
  Node exited the whole process. The first abuse check only verified the
  client's close code and passed. It surfaced when a load test ran on 2
  instances instead of 3. Fix: an `error` listener per socket; the check now
  counts running instances (3 → 2 before, 3 → 3 after). *Verify the server
  survived, not only the client's view.*
- **A test that couldn't fail.** The first resync test showed 0 stale clients on
  old and new code: node-redis resubscribes within milliseconds, before a change
  reaches its publish. A flapping link (400 ms) separated them, 194 vs 0. *A test
  proves something only if it fails on the broken version.*
- **A race random tests never hit.** The broadcast hand-off race passed every
  random scenario even with the fix removed; only a forced interleaving exposed
  it. *Force concurrency bugs; don't wait for them.*
- **Measuring the tooling.** k6 spent ~6 cores parsing JSON and limited the
  results; one round of runs was on battery and the laptop slept mid-run. Both
  were discarded, k6 was changed to parse lazily, and the runner refuses to start
  on battery.
- **A check that didn't block.** A scan found JWTs in raw output files, but a
  chained command committed anyway. The unpushed commits were rewritten and the
  runner now strips setup data from k6 summaries.
- **An unreproduced observation.** nginx's 60 s connect hang to a killed
  instance appeared once; its trial files had been deleted, and the later
  before/after run didn't reproduce it. The 2 s timeout is justified by that one
  observation, without a measured before/after.

## Future work

In priority order:

1. **Lower Q&A bandwidth for HLS viewers.** Their video is 2–3 s behind, so 1
   update/s instead of 4 costs them nothing and cuts Q&A egress at 10,000
   viewers from ~4.4 to ~1.2 Gbps ([capacity](capacity.md)).
2. **CI.** A GitHub Actions job: `docker compose up`, then the smoke, access,
   abuse and ranking checks.
3. **Real HLS.** Self-hosted `livekit-server` + `livekit/egress` writing segments
   to MinIO (the commented `EgressClient` path in `egressService.js`), then
   short-lived signed URLs for `/hls/`, which is currently unauthenticated.
4. **Playlist caching.** A ~1 s CDN cache on `.m3u8` (≈ 4,750 → 60 origin
   requests/s at 10,000 viewers).
5. **Robustness edges.** Dead-letter flush rows Postgres keeps rejecting; an
   epoch per live buffer so clients reset their `seq` guard if a buffer is
   cleared during a Redis outage; versioned key names for rolling upgrades.
6. **Replication.** Redis Sentinel or replica, a Postgres replica with failover,
   two gateways.
7. **Browser tests** (e.g. Playwright) for the React client, which is currently
   verified through scripted clients.
