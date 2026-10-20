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
