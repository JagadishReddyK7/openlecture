# Capacity estimate: one lecture, 10,000 viewers

A back-of-envelope sizing for the target in the requirements: one instructor
streaming to thousands of students, with live upvoted Q&A. Every number is
tagged as one of:

- **A** an assumption, stated so it can be challenged
- **M** a measurement from this repo, with a link to the run in [results.md](results.md)
- **E** an estimate derived from A and M by the arithmetic shown

The measurements come from one laptop: Docker Desktop, 14 vCPUs, the load
generator on the same machine. Treat per-core figures as order-of-magnitude.
Wherever an estimate extrapolates from them it is linear and labelled E.

## Assumptions

| | Assumption | Why this value |
|---|---|---|
| A1 | 10,000 concurrent viewers in one lecture | the design point in the requirements |
| A2 | Video averages 1.5 Mbps per viewer (range 1–2) | 720p at typical lecture motion |
| A3 | 500 WebRTC viewers, 9,500 HLS | `WEBRTC_PRIORITY_LIMIT=500` (ADR-001) |
| A4 | One SFU node serves 300–500 subscribers | depends heavily on hardware and simulcast; not measured here |
| A5 | HLS: 2 s segments, 3-rung ladder (0.8 / 1.5 / 3 Mbps), CDN with 20 edge POPs | a common setup |
| A6 | 80 % of viewers join in the first 60 s; the peak second is 4× the average | lectures start on the hour |
| A7 | Q&A peak: each viewer votes once per 10 s; 10 questions/s | a vote storm on a popular question |
| A8 | Q&A broadcast every 250 ms with the top 50 open questions | the current configuration (P2) |

## Video delivery

| | | Value |
|---|---|---|
| E | Total viewer egress: 10,000 × 1.5 Mbps | **15 Gbps** (10–20) |
| E | WebRTC tier from the SFU: 500 × 1.5 Mbps | 0.75 Gbps |
| E | SFU nodes for 500 subscribers (A4) | **1–2**, plus 1 spare. LiveKit Cloud runs these in this prototype |
| E | HLS tier: 9,500 × 1.5 Mbps | 14.25 Gbps, served by CDN edges |
| E | Origin egress for HLS with the CDN: each edge fetches each segment once per rendition: 20 × (0.8 + 1.5 + 3) Mbps | **≈ 106 Mbps** (≈ 0.7 % of 14.25 Gbps) |

**Design tie-in.** The two-tier split puts only 5 % of viewers on the SFU and
95 % on a cacheable path. That offload holds only if segments are cacheable,
which is why nginx serves `*.ts` / `*.m4s` as `max-age=31536000, immutable`.

**Gap this exposes.** Playlists (`*.m3u8`) are served `no-cache`, so every HLS
viewer's playlist poll goes through to the origin: 9,500 viewers / 2 s
≈ **4,750 requests/s** (E). For live HLS the usual fix is a short CDN cache on
playlists (≈ segment duration / 2, i.e. 1 s), or LL-HLS blocking playlist
reload. Either collapses that to roughly 20 edges × 3 renditions per second
≈ 60 requests/s (E). Not implemented. The HLS tier itself is still a prototype
(it serves a public test stream).

## Join burst

| | | Value |
|---|---|---|
| E | Average join rate: 8,000 viewers in 60 s (A6) | 133 joins/s |
| E | Peak second (×4) | **≈ 530 joins/s** |
| M | Join cost: one Postgres query (enrollment folded in) + one Redis Lua call. No LiveKit API call | [P3](results.md) |
| M | Join latency at ~142 joins/s plus ~980 other req/s on 3 streaming-engine instances | median 3.6 ms, p95 10.7 ms; ~35 % CPU per instance ([P0](results.md), P3) |
| E | Instances to absorb 530 joins/s at ≤ 70 % CPU. Upper bound: all measured streaming-engine CPU (3 × 35 % ≈ 1.05 cores for 142 joins/s) is charged to joins, so ≈ 135 joins/s per core | **≤ 6 streaming-engine instances** (530 / 135 / 0.7 ≈ 5.6) |
| E | Postgres at 530 indexed point queries/s | negligible for one Postgres. Pool size (10 per instance) is the first limit |

**Design tie-in.** Slot allocation is one atomic Lua script (P0 fix), so a join
burst can't over-allocate WebRTC slots. Removing the LiveKit participant-count
call from every join took an external round trip off this hot path.

## Q&A fan-out

| | | Value |
|---|---|---|
| E | Peak votes (A7): 10,000 / 10 s | **1,000 votes/s** + 10 questions/s |
| M | Messages per viewer, whatever the vote rate (250 ms window) | 4.08 /s at 21–107 mutations/s ([P2a](results.md)) |
| M | Update size with top-50 bounding, 100 or 1,000 questions | 12–14 KB ([P2b](results.md)) |
| M | Bytes per viewer | **54.5 KB/s ≈ 0.44 Mbps** ([P4](results.md)) |
| E | Q&A egress for 10,000 viewers: 10,000 × 4.08 × 13.4 KB | **≈ 547 MB/s ≈ 4.4 Gbps** |
| E | Same load with the pre-P2 design: each vote sends the full list (270 KB at 1,000 questions, M, P2b) to everyone: 1,000 × 10,000 × 270 KB | ≈ 2.7 TB/s, i.e. not deliverable |

**Design tie-in.** Coalescing makes message rate a function of the window, not
of voting. Bounding makes message size a function of K, not of the lecture.
Together they turn an O(votes × viewers × questions) cost into
O(viewers × K × 4/s).

**Gap this exposes.** At 0.44 Mbps, Q&A is about **30 % of a 1.5 Mbps video
stream**: 4.4 Gbps against 15 Gbps total. Options, none implemented, sizes are E:
- Send HLS-tier viewers 1 update/s instead of 4. Their video is already 2–3 s
  behind, so 250 ms freshness buys nothing: (500 × 4 + 9,500 × 1) × 13.4 KB/s
  ≈ 154 MB/s, so 4.4 → ≈ 1.2 Gbps.
- `permessage-deflate`: the payload is repetitive JSON (the same keys in every
  question), so a several-fold reduction is plausible, at core-api CPU cost.
  Not measured.
- Deltas (only changed vote counts): smallest messages, but needs per-client
  state and resync. Rejected in P2b for complexity; worth revisiting at this
  scale.

### Servers for the fan-out

| | | Value |
|---|---|---|
| M | core-api CPU, 333 sockets per instance, 4 msg/s at 13.4 KB | ~11 % of a core per instance (P4-1000) |
| E | Sockets per core-api core (Node is single-threaded), linear | ≈ 3,000 |
| E | core-api instances for 10,000 sockets at ≤ 50 % CPU, so that losing one leaves the rest under ~60 % | **7–8** |
| M | core-api memory per socket (send buffers included) | ≈ 100 KB ([P4 stats](raw/p4-1000-stats.csv)) |
| E | Memory at 1,300 sockets per instance | ≈ 130 MB |
| M | nginx at 1,000 sockets / 56 MB/s | 24 % CPU, ≈ 32 KB per connection (P2b-1000, P4-1000) |
| E | nginx at 10,000 sockets / 547 MB/s | ≈ 2.4 cores, ≈ 320 MB. Fine on a multi-core box, but a single point of failure |
| M | Recovery when an instance with 332 sockets dies | all 332 reconnected within 1.0 s, 0 ACKed writes lost (P4 chaos) |
| E | Reconnect burst after losing one of 8 instances: 1,250 clients spread over ~1 s by full jitter | ≈ 1,250 ticket requests/s. The access check is a Redis `SISMEMBER`, not a DB query (P3) |

**Design tie-in.** Redis Pub/Sub carries **one** message per lecture per window
to each core-api instance. Its cost scales with instances (8 × 4/s), not with
viewers. The per-viewer copy happens on the instance that holds the socket.

## Redis

| | | Value |
|---|---|---|
| M | Redis commands per vote (Lua inner commands included) | 11, in 3 client round trips ([probe](raw/p5-probe.txt)) |
| M | Average Lua script time under load | 43 µs (`cmdstat_eval`, P4-1000) |
| E | Redis CPU for 1,000 votes/s: 2 scripts × 43 µs + 1 `HLEN` | ≈ 90 ms per second ≈ **9 % of its single core** |
| E | Votes/s before one Redis core saturates (writes only) | ≈ 10,000. Beyond that, shard lectures across Redis nodes |
| M | Memory of one live lecture at 1,000 questions / 20,000 votes | **3.4 MB** (probe) |
| M | Unflushed-change sets | ≈ 121 B per pending change (probe: 2.4 MB for ≈ 21,000) |
| E | Change sets at 1,000 votes/s, flushed every 5 s | ≈ 0.6 MB |
| E | 100 concurrent lectures of that size | ≈ 400 MB |
| M | Durability | AOF `everysec`: after SIGKILL, 10,000 of 10,000 writes kept; without AOF, 0 (P4) |

**Design tie-in.** Write-behind keeps the vote path at three Redis round trips
and no Postgres. Atomic Lua scripts make the vote check, count, ranking index
and change log one step, so a crash can't leave them disagreeing. Redis is
single-threaded and a single node here. With AOF it survives a restart (up to
~1 s of writes lost), but it is still a single point of failure: no replica or
Sentinel.

## Postgres writes

| | | Value |
|---|---|---|
| M | Flush at ~105 mutations/s: one transaction per lecture per 5 s, one multi-row insert per table | ~520 rows per flush in median 36 ms (p95 79 ms); Postgres 1.2 % CPU (P4-1000) |
| E | Flush at 1,000 votes/s: 5,000 rows per 5 s, scaling the measured time linearly | ≈ 350 ms per flush, inside the 5 s interval |
| E | Write rate | ≈ 1,000 rows/s in **0.2 transactions/s** per lecture, vs ≈ 1,000 transactions/s if each vote were written synchronously |
| E | Same load with the pre-P4 flush (every row of the lecture re-upserted one by one every 5 s): after 1 h at 1,000 votes/s | 3.6 M upserts every 5 s, impossible to keep up with |
| E | Vote rows at 1,000/s for a 1 h lecture (≈ 100 B per row with its index) | ≈ 3.6 M rows, ≈ 360 MB |

**Design tie-in.** Postgres sees batches whose size tracks the rate of change,
not the size of the lecture. The trade-off is that a vote is in Redis (with AOF)
for up to 5 s before it is in Postgres.

## Summary for 10,000 viewers in one lecture

| Component | Sizing (E) | Main limit |
|---|---|---|
| SFU | 1–2 nodes + 1 spare | subscribers per node (A4) |
| HLS via CDN | ~106 Mbps origin egress for segments | playlist requests (~4,750/s while `no-cache`) |
| streaming-engine | ≤ 6 instances | join burst CPU |
| core-api | 7–8 instances | Q&A fan-out CPU (~3,000 sockets per core) |
| nginx | ~2.4 cores, ~320 MB | single instance, single point of failure |
| Redis | ~9 % of one core, a few MB per lecture | single node |
| Postgres | ~1,000 rows/s in 0.2 tx/s per lecture | single node |
| Q&A egress | ~4.4 Gbps (≈ 30 % of video) | the next optimisation target |

What this estimate does not cover:
- Multi-region delivery, and real SFU or CDN behaviour (both external here).
- Redis or Postgres failover.
- Many simultaneous large lectures. Redis and Postgres sizing above is per
  lecture: multiply by concurrent lectures.
