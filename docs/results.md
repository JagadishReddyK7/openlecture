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
