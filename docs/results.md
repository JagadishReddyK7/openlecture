# Measured results

Every number here comes from a run on the setup below. Raw output is in
[`raw/`](raw/). Nothing in this file is estimated. Estimates live in the
capacity document and are labelled there.

## Test environment

| | |
|---|---|
| Host | Intel Core Ultra 5 225H (14 logical CPUs), 15.4 GB RAM, Windows 11 |
| Docker | Docker Desktop, engine 29.4.0, WSL2 kernel 6.6.87.2; VM limit 14 CPUs / 7.5 GiB |
| Images | postgres:15-alpine, redis:7-alpine, nginx:1.25-alpine, minio/minio:latest, node:18-alpine (services) |
| Load generator | grafana/k6:1.3.0, run as a container on the same host and Docker network |
| Topology | 3 × core-api, 3 × streaming-engine, 1 × each of nginx, Postgres, Redis, MinIO |

Everything runs on one machine, so the load generator competes with the
services for CPU. These are single-host numbers, not cluster numbers.

Start the stack (PowerShell, from `globalclass/`):

```powershell
docker compose up -d --build --scale core-api=3 --scale streaming-engine=3
docker compose restart api-gateway   # nginx resolves upstream IPs only at startup
```

---

## P0 — Baseline (2026-10-20, base commit `dc08277` + P0 migration fix)

### Functional smoke test

```powershell
cd backend; node scripts/smoke.js
```

API + Q&A only (no browser, no video). Steps: instructor registers, creates and starts a lecture. Two
students enroll and join. One asks, the other votes, and the duplicate vote is rejected. A
second question goes out to 12 more sockets. Then the Postgres write-behind is checked.

Result: all 17 checks passed. The 15 sockets of the second run were spread
5 / 5 / 5 over the three core-api replicas (from `docker compose logs core-api`),
and all 12 extra sockets got the update. That is the Redis Pub/Sub relay working
between instances. After the 5 s flush the question and its vote were in Postgres
(`questions` / `votes` rows checked with psql), and the `qa:*` keys were deleted once the
last socket closed.

Not covered: video (needs a browser + LiveKit Cloud). The WebRTC/HLS
playback path still needs a manual browser check.

Fixed before measuring: migrations never ran on the Docker stack, so a fresh
`docker compose up` had no tables. core-api now runs the migration on startup
under a Postgres advisory lock. All 3 replicas started at the same time without error.

### k6 HTTP stress (`load_test.js`, STRESS profile)

```powershell
docker run --rm -i --network globalclass_default -v ${PWD}/load_test.js:/load_test.js `
  grafana/k6:1.3.0 run /load_test.js --env STRESS=true --env STUDENTS=200 `
  --summary-trend-stats "avg,min,med,p(90),p(95),p(99),max" --summary-export /out/p0-stress-summary.json
.\scripts\sample-stats.ps1 -Out ..\docs\raw\p0-stress-stats.csv -Seconds 560   # in parallel
```

Profile: ramps 0 → 100 → 300 → 600 → 1000 VUs over 7 min, then down to 0 over 1 min. 200 distinct
student accounts, shared by VUs via modulo. Each iteration: health check →
`/stream/join` → status polls (`/stream/hls-status`) → occasional catalog fetch.

| Metric | Value |
|---|---|
| HTTP requests | 554,925 (1,125 req/s average over the whole run) |
| Failed requests | 0.00 % |
| `http_req_duration` | med 1.60 ms · p95 5.37 ms · p99 10.36 ms · max 466 ms |
| `/stream/join` latency | med 3.31 ms · p95 9.86 ms · p99 18.03 ms · max 108 ms |
| Iterations (joins) | 70,090 |
| Tier split | 70,090 WebRTC · 0 HLS |
| Peak VUs | 999 |

Server CPU from `docker stats` (100 % = one core). The table uses the 250 samples per
container from 21:53:18 to 22:01:43, which covers the k6 run including `setup()`. The CSV also
holds 19 idle samples taken after k6 exited. Including them lowers the means by
about 2 points and leaves the peaks unchanged.

| Container | mean % | peak % |
|---|---:|---:|
| streaming-engine (each of 3) | 34.2–34.5 | 88.7–91.1 |
| api-gateway (nginx) | 26.8 | 76.6 |
| postgres | 8.7 | 25.7 |
| core-api (each of 3) | 6.8–7.0 | 83.2–88.8 |
| redis | 2.0 | 7.0 |
| minio | 0.9 | 10.3 |

**What this shows and what it doesn't:**
- No breaking point was reached. At 999 VUs, p95 stayed at 5 ms, there were no errors, and
  no container was pinned. So this run does **not** give a capacity number. It
  only shows the HTTP path is fine at this rate on this host.
- The workload is light. Most requests are `hls-status` polls that return
  a constant. The rate is still bounded by the script's per-VU sleep
  (`PACE=0.1`), not by the server.
- All joins got WebRTC because 200 students < `WEBRTC_PRIORITY_LIMIT` (500), and
  each student keeps the same slot. The HLS tier and segment downloads were
  **not** exercised. That needs `STUDENTS > 500`.
- The core-api peaks (≈85 %) are most likely the 200 bcrypt registrations in
  `setup()`. core-api serves only the health checks and catalog afterwards. This
  is an inference, not checked against timestamps.
- k6's own CPU was not sampled (the sampler filters on `globalclass`).
- **Q&A was not load-tested here.** k6 opens no WebSockets. That is P1.

Raw: [`raw/p0-stress-k6.txt`](raw/p0-stress-k6.txt),
[`raw/p0-stress-summary.json`](raw/p0-stress-summary.json),
[`raw/p0-stress-stats.csv`](raw/p0-stress-stats.csv).

---

## P1 — Q&A WebSocket load, "before" (2026-10-20/21)

Docker Desktop was updated before this phase: engine **29.9.1** (P0 used
29.4.0). All P1 and later runs use 29.9.1. All runs listed here were on AC power
(checked with `Win32_Battery`; the run script now refuses to start on battery).

### What was measured

`globalclass/k6/qa_ws_test.js`, driven by `scripts/run-qa-load.ps1`:

```powershell
.\scripts\run-qa-load.ps1 -Clients 200 -Tag p1-200   # likewise 500, 1000
```

- **Clients:** one lecture, `CLIENTS` distinct student accounts, one `/qaws` socket each. Connects are spread over a 30 s ramp, followed by a 5 s settle and then a **120 s steady window**. Every metric below covers only the steady window.
- **Workload, per client:**
  - 5 % of clients are askers: one question every 10–20 s, until the lecture has 100 questions (`QMAX`).
  - The rest are voters: one upvote every 5–15 s, on a random question they haven't voted for yet.
- **Update latency:** each mutation carries a `clientMsgId`. The server ACKs it with the lecture's sequence number `seq` (added in this phase, see below). The latency is the time from send to the first `QUESTIONS_UPDATE` with `seq ≥` that number, which is exactly the first update that contains the change.
- **Bytes:** WebSocket payload characters received by clients (all ASCII, so chars = bytes; frame headers not counted).
- **Server side:** `docker stats` per container, plus Redis `INFO` after `CONFIG RESETSTAT`. The Redis counts cover the whole run (setup + ramp + steady), not only the steady window.

Server changes made for the measurement, which leave fan-out behavior unchanged:
- `seq`: one Redis `INCR` per mutation, a `seq` field on every update, and an `ACK` to the sender. Compared with the original code, that's one extra Redis command and one small message per mutation.
- Fixed a connect race: message/close listeners were attached only after three awaits, so a message sent right after the socket opened was silently dropped, and an early close never decremented the lecture-wide connection count.
- Removed a per-connection log line that printed the full URL, JWT included.

### Results

| Clients | 200 | 500 | 1000 |
|---|---:|---:|---:|
| Completed? | **yes** | no: load generator exhausted memory at steady +41 s | no: load generator OOM-killed during ramp |
| Mutations (cluster-wide, steady) | 21.3 /s | – | – |
| Update latency | med 7 · p95 20 · p99 32 · max 62 ms | – | – |
| Messages received per client | 21.4 /s | – | – |
| Bytes received per client | 396 KB/s | – | – |
| Bytes received, all clients | 79.2 MB/s | – | – |
| Mean message size | 18.5 KB | – | – |
| ACK timeouts / errors / abnormal closes | 0 / 0 / 0 | – | – |
| Egress through nginx (`docker stats` tx) | 82.3 MB/s | **433 MB/s** (first 41 s of steady) | – |
| Egress per core-api replica | 26–28 MB/s | 142–144 MB/s | – |
| CPU, core-api (each, mean) | 9–11 % | 74–80 % | – |
| CPU, nginx (mean) | 24 % | 206 % | – |
| CPU, Redis (mean) | 2.1 % | 4.7 % | – |
| CPU, k6 load generator (mean) | 154 % | 670 % | – |
| Sockets per core-api replica | 68 / 67 / 65 | 164 / 165 / 171 | 333 / 332 / 335 |

Redis, 200 clients, whole run: 2,914 `PUBLISH` and 6,294 `HGETALL` (two per
broadcast: questions + vote counts, plus the initial snapshot for each socket).
Redis output was 220 MB.

### Reading the numbers

- **Every mutation fans out to every client.** At 200 clients, 21.3 mutations/s
  turned into 21.4 messages/s for *each* client. Each one is the full ranked
  list (18.5 KB on average once the lecture fills up to 100 questions), so the
  cluster sent ~4,280 messages/s and ~80 MB/s for 21 votes per second.
- **The cost grows with N² × list size.** Mutations per second grow with N, and
  each one is sent to N clients. Going from 200 to 500 clients (2.5×) took
  egress from 82 MB/s to 433 MB/s (5.3×), and core-api CPU per replica from
  ~10 % to ~77 %.
- **500 and 1000 could not be measured on this host.** That is the result for those levels, not
  a gap in the data. With the clients receiving ~433 MB/s, k6 could not keep up, and its
  queued messages grew its memory to 6.2 GiB of the 7.5 GiB Docker VM, which then stopped
  responding (k6 exit 125 after ~20 min). At 1000, k6 reached 5.4 GiB during the ramp and was
  killed (exit 137, consistent with OOM) before the steady window started.
  The servers themselves stayed up (no restarts), but no client-side numbers exist for these
  levels. The run script now caps k6 at `--memory 5g`, so an overload kills k6 instead of
  hanging the VM.
- The 200-client latency (p95 20 ms) is fine. At this size the old
  design is correct and fast; the problem is the bandwidth and CPU it takes to stay fast.

### Discarded runs

A first attempt at all three levels ran on battery. The laptop hit "critical
battery" and slept at 23:04, freezing the 500 run for an hour. Those files were
deleted and are not reported. That attempt also showed k6 spending ~6 cores
running `JSON.parse` on every broadcast. The script now reads `seq` from the
message prefix and parses the list only when a vote needs it, so the services
rather than the client set the numbers.

Raw: `raw/p1-{200,500,1000}-{k6.txt,derived.txt,stats.csv,redis.txt}`,
`raw/p1-200-summary.json`.

---

## P2a — Coalesced broadcasts (2026-10-26)

Same host, engine 29.9.1, AC power, 3 × core-api. Same k6 script and workload
as P1. Window `QA_BROADCAST_WINDOW_MS=250`. Each broadcast is still the
**full** list; bounding it is P2b.

### Correctness check (no load generator)

```powershell
cd backend; node scripts/coalesce-check.js     # compose Redis on :6379
```

Three broadcaster instances, each with its own Redis connection, share one lecture:

| Scenario | Result |
|---|---|
| Storm: 10,000 mutations from 90 concurrent writers over 7.2 s | 28 broadcasts. Last seq = final version (10,000). Seq strictly increasing. Min gap 256 ms. Worst mutation → covering broadcast 296 ms (p50 141 ms) |
| Window edge: 200 single mutations spaced 210–290 ms apart | 188 broadcasts, last seq = final version, worst 307 ms |
| Isolated mutation after quiet | published in 27 ms (leading edge, no window wait) |
| Hand-off race, forced: mutation lands while the loop is exiting after release | published in 125 ms |
| Crashed lease holder (lease taken, never published) | sweeper published after 2,039 ms (lease 2 s + sweep every 1 s) |

The hand-off scenario was checked against a deliberately broken
broadcaster with the re-run hand-off removed. That version **fails** it at 2,769 ms: the update
waits for the lease to expire and the sweeper to pick it up. The random scenarios
alone passed even with the bug, so this scenario is what covers it.

### Load test

```powershell
.\scripts\run-qa-load.ps1 -Clients 200 -Tag p2a-200   # likewise 500, 1000
```

| Clients | 200 | 500 | 1000 |
|---|---:|---:|---:|
| Completed? | yes | **yes** | **yes** |
| Mutations (cluster-wide, steady) | 20.8 /s | 52.0 /s | 107.4 /s |
| Update latency | med 135 · p95 249 · p99 263 · max 295 ms | med 140 · p95 254 · p99 268 · max 290 ms | med 147 · p95 264 · p99 292 · max 452 ms |
| Messages received per client | 4.05 /s | 4.07 /s | 4.08 /s |
| Bytes received per client | 68.7 KB/s | 102 KB/s | 108 KB/s |
| Bytes received, all clients | 13.7 MB/s | 51.0 MB/s | 108 MB/s |
| Mean message size | 16.9 KB | 25.0 KB | 26.5 KB |
| ACK timeouts / errors / abnormal closes | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Egress through nginx (`docker stats` tx) | 14.3 MB/s | 52.3 MB/s | 109 MB/s |
| Egress per core-api replica | 4.5–5.2 MB/s | 16.8–17.7 MB/s | 36.0–36.3 MB/s |
| CPU, core-api (each, mean) | 3.4–4.9 % | 7.2–12.0 % | 12.8–23.8 % |
| CPU, nginx (mean) | 5.9 % | 18.1 % | 36.8 % |
| CPU, Redis (mean) | 1.7 % | 2.2 % | 3.1 % |
| CPU, k6 (mean) | 31 % | 101 % | 200 % |
| Sockets per core-api replica | 63 / 74 / 63 | 170 / 160 / 170 | 332 / 334 / 334 |
| Redis `PUBLISH` (whole run) | 590 | 603 | 611 |

Messages per client are ~4.0/s whatever the vote rate (20.8 → 107/s). The 0.1/s
above that is the ACK each client gets for its own mutations. The `PUBLISH`
count barely moves with load because there is one publisher per lecture per window.

### Before vs after, 200 clients (the only level P1 completed)

| | P1 (before) | P2a (after) | Change |
|---|---:|---:|---:|
| Messages per client | 21.4 /s | 4.05 /s | −81 % |
| Bytes per client | 396 KB/s | 68.7 KB/s | −83 % |
| Egress through nginx | 82.3 MB/s | 14.3 MB/s | −83 % |
| core-api CPU (each, mean) | 9–11 % | 3.4–4.9 % | about −60 % |
| Update latency p95 | 20 ms | 249 ms | **+229 ms** |

At 500 clients, P1's 433 MB/s egress drove the load generator out of memory.
P2a sustained 500 clients at 52 MB/s and 1000 clients at 109 MB/s.

### Reading the numbers

- **Messages are now bounded by the window, not the vote rate.** That is the design
  goal. Egress grows linearly with clients (≈ 4/s × payload × N), not with clients × votes.
- **Latency got worse at this load, as expected.** Under steady voting almost every
  mutation lands inside an open window, so it waits for that window's trailing
  broadcast: median ≈ half a window, p95 ≈ one window. That is the price of the
  bound. It holds flat from 200 to 1000 clients (p95 249 → 264 ms) while the
  vote rate grew 5×. An isolated mutation still goes out immediately (27 ms in
  the check above).
- **Payload size is now the dominant cost.** Mean message size grew from 16.9 KB to
  26.5 KB as the lecture filled to 100 questions with larger vote counts. Bytes per
  client at 1000 (108 KB/s) are mostly list size. That is what P2b bounds.
- Max latency 452 ms at 1000 clients is the one outlier above window + 200 ms.
  The cause wasn't investigated, and nothing was dropped (0 ACK timeouts).

Raw: `raw/p2a-{200,500,1000}-{k6.txt,summary.json,derived.txt,stats.csv,redis.txt}`.

---

## P2b — Bounded payload + incremental ranking (2026-10-26)

Same host, engine 29.9.1, AC power, 3 × core-api, window 250 ms. Each update
now carries the top 50 unanswered questions in the strategy's order, the 20
most recently answered, and counts for the whole lecture (`QA_TOP_K`,
`QA_ANSWERED_K`). The order comes from per-lecture Redis sorted sets kept up
to date by the vote, submit and answer scripts, so building an update reads
50 + 20 entries instead of `HGETALL` + sort over every question.

### Correctness checks

```powershell
docker compose exec -T core-api node scripts/ranking-check.js
cd backend; node scripts/smoke.js
```

`ranking-check.js` runs inside a core-api container because a native Windows
PostgreSQL on this host also listens on `:5432` and answers `localhost`
first. Redis on `localhost:6379` was checked to be the compose instance
(same `run_id`), so the P2a coalescing check stands.

| Check | Result |
|---|---|
| 300 questions, 3,000 skewed random votes (2,911 accepted, 89 duplicates), 40 answered: top 50 from the index vs sorting the full list in memory | identical, including vote counts, for `default`, `votes` and `recency` |
| Counts | 300 total / 260 unanswered / 40 answered for every strategy |
| Answered list | the 20 most recently answered, newest first |
| Vote on unknown question | rejected (`Question not found`), no vote-count entry created |
| Vote on answered question | accepted |
| Payload with 300 questions | 17,059 B bounded vs 72,619 B full list |
| Smoke test (extended) | 21/21 pass |

The smoke test now also sends a vote for a nonexistent question, marks a
question answered, and reads the lecture back through REST **after all sockets
close**. That read is served from Postgres once the buffer is cleared, so it
checks the flush rather than the Redis buffer.

**Regression check against P2a (`35f91a6`):** the same smoke test fails 4
checks on the old code. The bad vote is accepted, and **0 of 2 questions reach
Postgres**: the vote's dangling foreign key rolls back every flush of the
lecture, and the buffer is then deleted. One of the 4 failures, "answered
question moves to the answered list", is only the new payload shape, not a bug.

### Load test, same workload as P2a (up to 100 questions)

```powershell
.\scripts\run-qa-load.ps1 -Clients 200 -Tag p2b-200   # likewise 500, 1000
```

| Clients | 200 | 500 | 1000 |
|---|---:|---:|---:|
| Mutations (cluster-wide, steady) | 21.5 /s | 51.7 /s | 102.4 /s |
| Update latency | med 132 · p95 247 · p99 256 · max 264 ms | med 139 · p95 251 · p99 263 · max 317 ms | med 145 · p95 259 · p99 280 · max 339 ms |
| Messages received per client | 4.07 /s | 4.08 /s | 4.07 /s |
| Bytes received per client | 49.2 KB/s | 54.4 KB/s | 54.4 KB/s |
| Mean message size | 12.1 KB | 13.3 KB | 13.4 KB |
| Egress through nginx | 10.3 MB/s | 27.9 MB/s | 56.2 MB/s |
| Egress per core-api replica | 3.2–3.7 MB/s | 8.9–9.6 MB/s | 18.4–18.9 MB/s |
| CPU, core-api (each, mean) | 2.2–4.1 % | 4.8–10.1 % | 10.2–20.6 % |
| CPU, nginx (mean) | 4.3 % | 11.0 % | 23.8 % |
| CPU, k6 (mean) | 24 % | 71 % | 166 % |
| `HGETALL` calls (whole run) | 128 | 124 | 170 |
| ACK timeouts / errors / abnormal closes | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

vs P2a at 1000 clients: bytes per client 108 → 54.4 KB/s (−50 %), egress
109 → 56 MB/s, core-api CPU 12.8–23.8 % → 10.2–20.6 %. `HGETALL` dropped from
1,352 to 170 per run. The remaining calls are connects that arrive before any
snapshot exists, plus the flush. Message size now stays at ~13 KB as the lecture fills.
In P2a it grew from 17 to 26 KB.

### Large lecture: 1,000 questions, 500 clients, P2a vs P2b

```powershell
.\scripts\run-qa-load.ps1 -Clients 500 -Tag p2b-large -K6Env 'SEED_QUESTIONS=1000','QMAX=1100'
# p2a-large: same command with core-api built from 35f91a6
```

1,000 questions are created through REST in `setup()` before anyone connects.
The workload is otherwise identical. Both runs are on the same stack, a few minutes apart.

| | P2a (full list) | P2b (bounded) | Change |
|---|---:|---:|---:|
| Mean message size | 269.5 KB | 13.7 KB | −95 % |
| Bytes received per client | 1,059 KB/s | 55.8 KB/s | −95 % |
| Egress through nginx | 531 MB/s | 28.1 MB/s | −95 % |
| Egress per core-api replica | 170–179 MB/s | 9.4–9.7 MB/s | |
| CPU, core-api (each, mean) | 29–35 % | 4.9–11.6 % | |
| CPU, nginx (mean) | 89 % | 11.6 % | |
| Redis output bytes (whole run) | 854 MB | 62 MB | |
| Update latency p95 / p99 / max | 401 / 490 / 799 ms | 251 / 264 / 324 ms | |
| Messages per client | 3.93 /s | 4.07 /s | |

In P2a the k6 container averaged 706 % CPU (peak 882 %) receiving 531 MB/s. Some of
P2a's extra latency, and its slightly lower message rate, is therefore the
load generator falling behind. So that column gives P2a's server cost but
overstates its latency.

### Reading the numbers

- **Payload is now bounded by K, not by the lecture's size.** With 1,000
  questions the old update was 270 KB and went out 4 times a second to every
  client. Now it is ~14 KB whether the lecture has 100 questions or 1,000.
- **Combined with P2a**, per-client bytes at 500 clients went from "could not sustain"
  (P1: 433 MB/s egress at under 100 questions, then the host failed) to 27.9 MB/s.
- **Latency is unchanged from P2a** (p95 ≈ 250 ms). The window sets it, not the payload.
- **Behaviour changes:** clients see the top 50 open questions plus the 20 most recently
  answered. The full list is still available via `GET /api/lectures/:id/questions`.
  `votes` now breaks ties oldest-first, while `default` is still newest-first; before,
  `votes` had no defined tie order. The instructor's "answered" tab shows the latest 20.
- **Not verified in a browser.** The React views compile (`react-scripts build` with
  `DISABLE_ESLINT_PLUGIN=true`). A normal build fails on a pre-existing ESLint config
  error in `VideoPlayer.jsx` (`react-hooks/exhaustive-deps` rule not found), which
  this phase did not touch.

Raw: `raw/p2b-{200,500,1000,large}-*`, `raw/p2a-large-*`.

---

## P3 — Access control (2026-10-26)

Same host, engine 29.9.1, AC power, 3 × core-api, 3 × streaming-engine.

What changed:
- `/stream/join` requires enrollment, or being the lecture's instructor (403 `NOT_ENROLLED`).
- The Q&A WebSocket needs a one-time ticket: `POST /api/qa/ticket` (JWT in the header)
  returns a random 256-bit ticket. Redis holds it for 30 s and `GETDEL` makes it single use.
  The socket connects with `?ticket=`.
- Marking questions answered and changing the ranking need *this lecture's* instructor,
  not any instructor.
- REST question routes use the same rules, and their mutations now broadcast.

### Evidence of the problem

Before this phase, nginx's access log held **8,060 complete JWTs** from earlier test
runs, one per Q&A socket (`GET /qaws?lectureId=…&token=eyJ…`). Each one was a valid
24-hour bearer token for its user.

### Access matrix

```powershell
cd backend; node scripts/access-check.js     # through the gateway, ~40 s
```

All 23 checks pass:

| Request | Enrolled student | Lecture's instructor | Not-enrolled student | Other instructor |
|---|---|---|---|---|
| `POST /stream/join` | 200 | 200 | 403 | 403 |
| `POST /api/qa/ticket` | 200 | 200 | 403 | 403 |
| WS `MARK_ANSWERED` / `SET_STRATEGY` | refused | allowed | (no ticket) | (no ticket) |
| REST `PATCH …/answer` | 403 | (not run) | (not run) | 403 |
| REST `GET …/questions` | (not run) | (not run) | 403 | (not run) |

Tickets for an unknown or malformed lecture id get 404; a request with no JWT gets 401.
The WebSocket closes with 4001 for: a reused ticket, a ticket for a different lecture,
no ticket, a JWT in the URL (the old scheme), and a ticket older than 30 s. A student
refused a ticket gets one right after enrolling, because "not enrolled" is never cached.

After these runs: no core-api restarts, no unhandled-rejection log lines, and no
`qa:conn:*` keys left behind, so refused sockets don't skew the connection count.
nginx logged 23 `/qaws` requests while the checks ran: 21 with `ticket=`, 1 with no
credentials, and 1 with `token=eyJ…`, the old-scheme request the check sends on purpose.

`smoke.js` (now via tickets): 21/21 pass.

### Join latency: P3 vs pre-P3 (`9e6df61`), same host and engine

Join now also asks Postgres whether the user is enrolled. That check is folded into the
query join already ran (an `EXISTS` on the `enrollments` unique index), so it adds no
round trip.

```powershell
docker run --rm -i --name globalclass-k6 --memory 5g --network globalclass_default `
  -v ${PWD}/load_test.js:/load_test.js -v ${PWD}/../docs/raw:/out grafana/k6:1.3.0 run /load_test.js `
  --env STRESS=true --env STUDENTS=200 --summary-trend-stats "avg,min,med,p(90),p(95),p(99),max" `
  --summary-export /out/p3-stress-summary.json
```

Run back to back, with only the streaming-engine image swapped. `load_test.js` now
enrolls its students in `setup()`. That step is harmless before P3 and required after it.

| `/stream/join` | pre-P3 | P3 |
|---|---:|---:|
| median | 3.52 ms | 3.58 ms |
| p95 | 12.89 ms | 10.68 ms |
| p99 | 49.70 ms | 28.30 ms |
| max | 524 ms | 397 ms |
| joins (iterations) / failed requests | 70,041 / 0 % | 70,103 / 0 % |
| all HTTP p95 | 6.78 ms | 5.81 ms |

The medians are within 0.06 ms of each other. The tails differ in P3's favour, which is
run-to-run noise on a shared laptop, not an improvement. Conclusion: no measurable join
cost. CPU samples exist only for the pre-P3 run (streaming-engine mean 36.7–36.9 % each):
a quoting bug in the run command made the second run overwrite the first one's console
log and CSV. The latency numbers come from each run's own summary file.

### Q&A with tickets, 1000 clients (vs P2b-1000)

```powershell
.\scripts\run-qa-load.ps1 -Clients 1000 -Tag p3-1000
```

| | P2b-1000 | P3-1000 |
|---|---:|---:|
| Ticket request (`POST /api/qa/ticket`) | – | med 2.4 · p95 7.9 · p99 18.8 · max 36 ms, 0 errors |
| WebSocket open | med 1 · p95 2 ms | med 1 · p95 2 ms |
| Messages / bytes per client | 4.07 /s · 54.4 KB/s | 4.07 /s · 54.4 KB/s |
| Update latency | med 145 · p95 259 · p99 280 ms | med 148 · p95 258 · p99 280 ms |
| ACK timeouts / errors / abnormal closes | 0 / 0 / 0 | 0 / 0 / 0 |
| CPU, core-api (each, mean) | 10.2–20.6 % | 10.5–21.7 % |

Connecting now costs one extra HTTP request (median 2.4 ms) before the socket opens.
Everything after the connect is unchanged.

Raw: `raw/p3-1000-*`, `raw/p3-stress-summary.json`, `raw/p2b-stress-{summary.json,k6.txt,stats.csv}`.
